import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { findBase } from '../scripts/lib/logo-frame.mjs';
import { fillHoles, opaqueMask } from '../scripts/lib/shape-ops.mjs';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { opaqueBox, readRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { buildSvg, findVtracer, runVectorize } from '../scripts/lib/vectorize-run.mjs';
import { DARK, LIGHT, MID, emblem } from '../test-support/emblem.mjs';
import { getPixel } from '../test-support/synthetic.mjs';

let vtracer;
try {
    vtracer = findVtracer();
} catch {
    vtracer = undefined;
}
const needsVtracer = { skip: vtracer ? false : 'vtracer is not installed' };
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'vectorize.mjs');
const NOW = () => new Date('2026-11-01T12:00:00.000Z');
// The drift a model leaves: the base is near the brand colour, not on it.
const DRIFTED = [136, 99, 158];

async function workspace() {
    const rootDir = mkdtempSync(join(tmpdir(), 'sb-vectorize-'));
    mkdirSync(join(rootDir, 'approved'));
    const picture = emblem();
    for (let at = 0; at < picture.data.length; at += 4) {
        if (picture.data[at] === MID[0] && picture.data[at + 1] === MID[1] && picture.data[at + 2] === MID[2]) {
            picture.data.set(DRIFTED, at);
        }
    }
    const inPath = join(rootDir, 'approved', 'logo.png');
    await writeRaster(inPath, picture);
    return { rootDir, inPath };
}

const request = (rootDir, inPath, extra = {}) => ({ rootDir, inPath, outDir: join(rootDir, 'raw', 's4', 'v'), sheetPath: join(rootDir, 'out', 's4', 'sheet.png'), baseHex: '#8b64aa', vtracer, now: NOW, ...extra });
const render = async (svgPath) => {
    const svg = readFileSync(svgPath, 'utf8');
    const side = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
    const { data } = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: side, height: side, data };
};

test('the SVG is small and plain: one path per tone, the base tone exactly the brand colour, a viewBox with no fixed size and no metadata', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runVectorize(request(rootDir, inPath));
    const svg = readFileSync(join(rootDir, 'raw', 's4', 'v', 'logo-base.svg'), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+">/);
    assert.deepEqual([...svg.matchAll(/<path fill="(#[0-9a-f]{6})"/g)].map((match) => match[1]), ['#8b64aa', '#593c67', '#ab8bbb']);
    assert.ok(!/transform|<!--|metadata|<\?xml|width=|height=|<g[ >]/.test(svg), 'nothing but the svg and its paths');
    assert.ok(svg.length < 6000, `${svg.length} bytes`);
    assert.deepEqual(result.tones.map(({ hex }) => hex).sort(), ['#593c67', '#8b64aa', '#ab8bbb']);
    assert.equal(result.files[0].bytes, Buffer.byteLength(svg));
    assert.equal(result.files[0].gzipBytes, gzipSync(svg).length);
    assert.equal(gunzipSync(gzipSync(svg)).toString(), svg);
    for (const variant of ['a', 'b']) {
        const shaded = readFileSync(join(rootDir, 'raw', 's4', 'v', `logo-base-lines-${variant}.svg`), 'utf8');
        assert.deepEqual([...shaded.matchAll(/<path fill="(#[0-9a-f]{6})"/g)].map((match) => match[1]), ['#8b64aa', '#593c67', '#ab8bbb'], `${variant}: still one path per tone`);
        assert.ok(!/transform|<!--|metadata|<\?xml|width=|height=|<g[ >]/.test(shaded));
        assert.ok(shaded.length > svg.length, `${variant}: the shading adds to the path data`);
    }
});

test('the drawing matches the picture it was traced from, in shape and in tone', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runVectorize(request(rootDir, inPath, { centrings: ['bbox'] }));
    assert.ok(result.check.wrongShape < 0.03, `${result.check.wrongShape}`);
    const rendered = await render(join(rootDir, 'raw', 's4', 'v', 'logo-bbox.svg'));
    const inside = (x, y) => getPixel(rendered, x, y);
    const box = opaqueBox(rendered, 128);
    const [dx, dy] = [box.x - 27, box.y - 70];
    const at = (x, y) => inside(x + dx, y + dy);
    assert.deepEqual(at(200, 360).slice(0, 3), [139, 100, 170], 'the dome is the brand colour');
    assert.deepEqual(at(200, 376).slice(0, 3), DARK, 'the dark band');
    assert.deepEqual(at(140, 120).slice(0, 3), LIGHT, 'the charm');
    assert.equal(at(175, 360)[3], 0, 'a letter hole stays a hole');
});

test('base centring puts the dome on the axis and bbox centring puts the whole box there, each with equal top and bottom margins', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    await runVectorize(request(rootDir, inPath));
    const base = await render(join(rootDir, 'raw', 's4', 'v', 'logo-base.svg'));
    const bbox = await render(join(rootDir, 'raw', 's4', 'v', 'logo-bbox.svg'));
    const baseBox = opaqueBox(base, 128);
    const bboxBox = opaqueBox(bbox, 128);
    assert.ok(Math.abs(findBase(base).centreX - base.width / 2) <= 2, `base at ${findBase(base).centreX} of ${base.width}`);
    assert.ok(Math.abs(baseBox.x + baseBox.width / 2 - base.width / 2) > 8, 'so the whole box is off the axis');
    assert.ok(Math.abs(bboxBox.x + bboxBox.width / 2 - bbox.width / 2) <= 2);
    for (const [picture, box] of [[base, baseBox], [bbox, bboxBox]]) {
        assert.ok(Math.abs(box.y - (picture.height - box.y - box.height)) <= 2, `top ${box.y}, bottom ${picture.height - box.y - box.height}`);
    }
});

test('the pixel drafts are the ears and dome only, centred on the dome, in the tones and full transparency, with the letters cut out of one of them', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    await runVectorize(request(rootDir, inPath));
    const draft = (name) => readRaster(join(rootDir, 'raw', 's4', 'v', `logo-${name}.png`));
    const drafts = { 'pixel-16': await draft('pixel-16'), 'pixel-32-sb': await draft('pixel-32-sb'), 'pixel-32-solid': await draft('pixel-32-solid') };
    for (const [name, picture] of Object.entries(drafts)) {
        const grid = Number(/pixel-(\d+)/.exec(name)[1]);
        assert.deepEqual([picture.width, picture.height], [grid, grid], name);
        const colours = new Set();
        for (let at = 0; at < picture.data.length; at += 4) {
            if (picture.data[at + 3] !== 0) {
                assert.equal(picture.data[at + 3], 255);
                colours.add([...picture.data.subarray(at, at + 3)].join());
            }
        }
        assert.ok(colours.size >= 1 && [...colours].every((rgb) => [[139, 100, 170], DARK, LIGHT].some((tone) => tone.join() === rgb)), `${name}: ${[...colours]}`);
        // The bottom row of the shape is the dome's, so its middle is the dome's middle.
        const box = opaqueBox(picture, 128);
        const bottom = Array.from({ length: grid }, (_, x) => x).filter((x) => picture.data[((box.y + box.height - 1) * grid + x) * 4 + 3] === 255);
        assert.ok(Math.abs((bottom[0] + bottom[bottom.length - 1] + 1) / 2 - grid / 2) <= 1, `${name} is centred on its dome`);
    }
    const holes = (picture) => {
        const mask = opaqueMask(picture);
        return fillHoles(mask, picture.width, picture.height).reduce((total, value, at) => total + (value === 1 && mask[at] === 0 ? 1 : 0), 0);
    };
    assert.equal(holes(drafts['pixel-16']), 0, 'no letters at 16');
    assert.equal(holes(drafts['pixel-32-solid']), 0, 'the solid dome has no holes');
    const box = opaqueBox(drafts['pixel-32-solid'], 128);
    assert.ok(box.width <= 26, `the line and dot on each side are gone, box ${JSON.stringify(box)}`);
    const lettered = drafts['pixel-32-sb'];
    const cut = Array.from({ length: 32 * 32 }, (_, at) => at).filter((at) => lettered.data[at * 4 + 3] === 0 && drafts['pixel-32-solid'].data[at * 4 + 3] === 255);
    assert.ok(cut.length >= 15, `the SB is cut out of the dome: ${cut.length} cells`);
});

test('the lower edge of a line is dark in A, and in B its upper edge is light too, with the rest of the line the brand colour', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runVectorize(request(rootDir, inPath));
    assert.equal(result.lines.thickness, 6);
    assert.deepEqual(result.lines.bands, { dark: 2, light: 1 });
    const pixelAt = async (name, x, y) => {
        const picture = await render(join(rootDir, 'raw', 's4', 'v', name));
        const box = opaqueBox(picture, 128);
        return getPixel(picture, x + box.x - 27, y + box.y - 70).slice(0, 3);
    };
    // The left line is rows 348 to 353 of the source, at x = 80.
    assert.deepEqual(await pixelAt('logo-base.svg', 80, 353), MID, 'unshaded');
    assert.deepEqual(await pixelAt('logo-base-lines-a.svg', 80, 353), DARK);
    assert.deepEqual(await pixelAt('logo-base-lines-a.svg', 80, 350), MID);
    assert.deepEqual(await pixelAt('logo-base-lines-a.svg', 80, 348), MID, 'A has no light edge');
    assert.deepEqual(await pixelAt('logo-base-lines-b.svg', 80, 353), DARK);
    assert.deepEqual(await pixelAt('logo-base-lines-b.svg', 80, 348), LIGHT);
    assert.deepEqual(await pixelAt('logo-base-lines-b.svg', 80, 350), MID);
    assert.deepEqual(await pixelAt('logo-base-lines-b.svg', 200, 340), MID, 'the dome keeps its own shading and is not touched');
    assert.deepEqual(result.lines.shaded.map(({ id }) => id), ['a', 'b']);
    assert.ok(result.lines.shaded.every(({ darkened }) => darkened > 0));
    assert.equal(result.lines.shaded[0].lightened, 0);
    assert.ok(result.lines.shaded[1].lightened > 0);
});

test('the band widths can be set, and the files hold the same three tones', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runVectorize(request(rootDir, inPath, { kDark: 3, kLight: 2 }));
    assert.deepEqual(result.lines.bands, { dark: 3, light: 2 });
});

test('the run is logged as a derived output with the source hash and every file hash, and writes the contact sheet', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runVectorize(request(rootDir, inPath));
    const [entry] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.deepEqual([entry.stage, entry.provider, entry.model, entry.template, entry.estimatedUsd], ['s4', 'local', 'vectorize', 'vectorize', 0]);
    assert.deepEqual(entry.refs, [sha256(readFileSync(inPath))]);
    assert.equal(entry.vars.source, 'approved/logo.png');
    assert.deepEqual(entry.vars.tones.sort(), ['#593c67', '#8b64aa', '#ab8bbb']);
    assert.equal(entry.outputs.length, 9, '3 SVGs for each of 2 centrings and 3 pixel drafts');
    assert.deepEqual(entry.vars.drafts, ['pixel-16', 'pixel-32-sb', 'pixel-32-solid']);
    assert.deepEqual(entry.vars.bands, { dark: 2, light: 1 });
    for (const { file, sha256: hash } of entry.outputs) {
        assert.equal(sha256(readFileSync(join(rootDir, file))), hash, file);
    }
    assert.equal(result.sheet, 'out/s4/sheet.png');
    const sheet = await sharp(join(rootDir, 'out', 's4', 'sheet.png')).metadata();
    assert.ok(sheet.width > 900 && sheet.height > 1000);
});

test('a second run into the same folder is refused before anything is written or logged', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    await runVectorize(request(rootDir, inPath));
    await assert.rejects(runVectorize(request(rootDir, inPath)), /already exists/);
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 1);
});

test('a preview writes its files and sheet under out/ and nothing to the log', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    const outDir = join(rootDir, 'out', 's4', 'preview');
    const result = await runVectorize(request(rootDir, inPath, { outDir, preview: true }));
    assert.equal(result.files.length, 6);
    for (const name of ['logo-base.svg', 'logo-base-lines-a.svg', 'logo-base-lines-b.svg', 'logo-bbox.svg', 'logo-pixel-16.png', 'logo-pixel-32-sb.png', 'logo-pixel-32-solid.png']) {
        assert.ok(existsSync(join(outDir, name)), name);
    }
    assert.ok(existsSync(join(rootDir, 'out', 's4', 'sheet.png')));
    assert.ok(!existsSync(join(rootDir, 'log')), 'no log folder or line');
    assert.equal(result.outputs.length, 9, 'the hashes are still reported');
});

test('a preview outside out/ is refused, because it would look like a logged output', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    await assert.rejects(runVectorize(request(rootDir, inPath, { preview: true })), /under out\//);
    assert.ok(!existsSync(join(rootDir, 'raw', 's4', 'v')));
});

test('a picture with no tone near the brand colour is refused and leaves nothing behind', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    await assert.rejects(runVectorize(request(rootDir, inPath, { baseHex: '#20c020' })), /No tone of the picture is near #20c020/);
    assert.ok(!existsSync(join(rootDir, 'raw', 's4', 'v')));
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 0);
});

test('the output folder must be inside raw/ or out/', needsVtracer, async () => {
    const { rootDir, inPath } = await workspace();
    await assert.rejects(runVectorize(request(rootDir, inPath, { outDir: join(rootDir, 'approved', 'v') })), /inside raw\/ or out\//);
});

test('buildSvg writes one path per layer, shifted by the offset, with the fill given', () => {
    const svg = buildSvg({ width: 20, height: 10, offsetX: 2, offsetY: 1, layers: [{ fill: '#8b64aa', commands: [{ command: 'M', points: [[0, 0]] }, { command: 'L', points: [[4, 0]] }, { command: 'L', points: [[4, 4]] }, { command: 'Z', points: [] }] }] });
    assert.equal(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path fill="#8b64aa" d="M2 1l4 0 0 4z"/></svg>\n');
});

test('a trace that is far from the picture is refused as broken, and nothing is written or logged', async () => {
    const { rootDir, inPath } = await workspace();
    // A stand-in for vtracer that "succeeds" with an empty drawing, which is what a failed layer looks like.
    const fake = join(rootDir, 'fake-vtracer');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake; exit 0; fi\nwhile [ "$1" != "-o" ]; do shift; done\necho \'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"></svg>\' > "$2"\n');
    chmodSync(fake, 0o755);
    await assert.rejects(runVectorize(request(rootDir, inPath, { vtracer: fake })), /is broken; nothing was written/);
    assert.ok(!existsSync(join(rootDir, 'raw', 's4', 'v')));
    assert.equal(readLog(join(rootDir, 'log', 'generations.jsonl')).length, 0);
});

test('a vtracer that fails is reported with its own message', async () => {
    const { rootDir, inPath } = await workspace();
    const fake = join(rootDir, 'failing-vtracer');
    writeFileSync(fake, '#!/bin/sh\necho "error: bad input" >&2\nexit 3\n');
    chmodSync(fake, 0o755);
    await assert.rejects(runVectorize(request(rootDir, inPath, { vtracer: fake })), /vtracer failed: error: bad input/);
});

test('the command refuses band widths that are not whole pixels, and a missing picture, before it reads anything', () => {
    const run = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    for (const [flag, value] of [['--k-dark', '0'], ['--k-dark', 'wide'], ['--k-light', '2.5']]) {
        const outcome = run(['--in', 'missing.png', flag, value, '--preview']);
        assert.equal(outcome.status, 1, flag);
        assert.match(outcome.stderr, new RegExp(`${flag} must be a whole number of pixels, 1 or more`));
    }
    assert.match(run([]).stderr, /Usage: vectorize\.mjs/);
});
