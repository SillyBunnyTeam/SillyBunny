import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { SHAPES, STYLES, runLogoPlates } from '../scripts/lib/logo-plates-run.mjs';
import { plateColours } from '../scripts/lib/plate.mjs';
import { writeRaster } from '../scripts/lib/raster.mjs';
import { findPotrace } from '../scripts/lib/potrace.mjs';
import { DARK, LIGHT, MID } from '../test-support/emblem.mjs';
import { LEFT_DOT, logoWithLines } from '../test-support/logo-lines.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

let potrace;
try {
    potrace = findPotrace();
} catch {
    potrace = undefined;
}
const needsPotrace = { skip: potrace ? false : 'potrace is not installed' };
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'logo-plates.mjs');
const NOW = () => new Date('2026-11-02T12:00:00.000Z');
const DRIFTED = [136, 99, 158];

async function workspace(picture = logoWithLines()) {
    const rootDir = mkdtempSync(join(tmpdir(), 'sb-plates-'));
    mkdirSync(join(rootDir, 'approved'));
    for (let at = 0; at < picture.data.length; at += 4) {
        if (picture.data[at] === MID[0] && picture.data[at + 1] === MID[1] && picture.data[at + 2] === MID[2]) {
            picture.data.set(DRIFTED, at);
        }
    }
    const inPath = join(rootDir, 'approved', 'logo.png');
    await writeRaster(inPath, picture);
    return { rootDir, inPath };
}

const request = (rootDir, inPath, extra = {}) => ({ rootDir, inPath, outDir: join(rootDir, 'out', 's4', 'plates'), sheetPath: join(rootDir, 'out', 's4', 'plates.png'), baseHex: '#8b64aa', potrace, preview: true, now: NOW, ...extra });
const fills = (svg) => [...svg.matchAll(/<(?:path|use) [^>]*?fill="(#[0-9a-f]{6})"/g)].map((match) => match[1]);
const render = async (path, side) => ({ side, data: await sharp(readFileSync(path), { density: 72 }).resize(side, side).ensureAlpha().raw().toBuffer() });
const pixelOf = ({ side, data }, x, y) => [...data.subarray((Math.floor(y) * side + Math.floor(x)) * 4, (Math.floor(y) * side + Math.floor(x)) * 4 + 4)];
const OUTPUTS = ['logo-emblem.svg', 'logo-emblem-nolines.svg', ...SHAPES.flatMap(({ id }) => STYLES.flatMap(({ id: style }) => [`logo-plate-${id}-${style}.svg`, `logo-plate-${id}-${style}-nolines.svg`]))];
const FINAL_OUTPUTS = ['logo-emblem.svg', 'logo-emblem-nolines.svg', 'logo-plate.svg', 'logo-plate-nolines.svg'];
const CHOICE = { shape: 'squircle', colour: 'light' };

test('a preview writes the clean emblem and every plate under out/, with a sheet, and nothing to the log', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runLogoPlates(request(rootDir, inPath));
    for (const name of OUTPUTS) {
        assert.ok(existsSync(join(rootDir, 'out', 's4', 'plates', name)), name);
    }
    assert.equal(OUTPUTS.length, 10, 'two emblems and a plate in each shape and colour, with and without lines');
    assert.deepEqual(result.files.map(({ file }) => file.split('/').pop()).sort(), [...OUTPUTS].sort());
    assert.equal(result.sheet, 'out/s4/plates.png');
    assert.ok((await sharp(join(rootDir, 'out', 's4', 'plates.png')).metadata()).width > 1400);
    assert.ok(!existsSync(join(rootDir, 'log')), 'no log folder or line');
    assert.equal(result.outputs.length, 10, 'the hashes are still reported');
});

test('the clean emblem is three paths in the logo\'s own tones, with the lines drawn as geometry on the right of the dome and the letters still cut out', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runLogoPlates(request(rootDir, inPath, { kDark: 3, kLight: 2 }));
    const out = join(rootDir, 'out', 's4', 'plates');
    const svg = readFileSync(join(out, 'logo-emblem.svg'), 'utf8');
    assert.deepEqual(fills(svg), ['#8b64aa', '#593c67', '#ab8bbb']);
    assert.ok(!/transform|<!--|metadata|<g[ >]|<circle|<rect/.test(svg), 'plain paths only');
    assert.deepEqual(fills(readFileSync(join(out, 'logo-emblem-nolines.svg'), 'utf8')), ['#8b64aa', '#593c67', '#ab8bbb']);
    assert.ok(svg.length > readFileSync(join(out, 'logo-emblem-nolines.svg'), 'utf8').length);

    const { side, offsetX, offsetY } = result.frame;
    const emblem = await render(join(out, 'logo-emblem.svg'), side);
    const bare = await render(join(out, 'logo-emblem-nolines.svg'), side);
    const at = (picture, x, y) => pixelOf(picture, x + offsetX, y + offsetY);
    assert.deepEqual(at(emblem, 55, 280).slice(0, 3), [139, 100, 170], 'the line is the brand colour');
    assert.equal(at(bare, 55, 280)[3], 0, 'and it is not in the emblem without lines');
    assert.deepEqual(at(emblem, 55, 283).slice(0, 3), DARK, 'dark along its lower edge');
    assert.deepEqual(at(emblem, 55, 277).slice(0, 3), LIGHT, 'light along its upper edge');
    assert.deepEqual(at(emblem, LEFT_DOT.cx, LEFT_DOT.cy).slice(0, 3), [139, 100, 170], 'the dot');
    assert.deepEqual(at(emblem, LEFT_DOT.cx, LEFT_DOT.cy + 12.5).slice(0, 3), DARK, 'its lower crescent');
    assert.deepEqual(at(emblem, LEFT_DOT.cx, LEFT_DOT.cy - 13).slice(0, 3), LIGHT, 'its upper crescent');
    assert.deepEqual(at(emblem, 110, 315).slice(0, 3), [139, 100, 170], 'the join with the dome is filled, not a hole where two outlines overlap');
    assert.equal(at(emblem, 175, 310)[3], 0, 'a letter stays cut out');
});

test('the lines are redrawn within a pixel or two of the picture, with one width and one dot size, and the numbers are reported', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runLogoPlates(request(rootDir, inPath));
    assert.equal(result.fits.length, 2);
    assert.equal(result.lineWidth, 7);
    assert.deepEqual(result.bands, { dark: 2, light: 1 });
    assert.ok(Math.abs(result.dotRadius - 14) < 0.3);
    for (const { deviation } of result.fits) {
        assert.ok(deviation.moved <= 1, `${deviation.moved} px from the picture`);
        assert.ok(deviation.dot.moved < 0.5 && Math.abs(deviation.dot.radiusChange) < 0.3);
        assert.ok(deviation.differentShare < 0.1);
    }
    assert.ok(result.bodyCheck.wrongShape < 0.03);
});

test('the dome sides are redrawn on one curve each, and the letters are traced within a pixel or two of the picture', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const { dome, letters } = await runLogoPlates(request(rootDir, inPath));
    for (const side of [dome.left, dome.right]) {
        assert.ok(side.used >= side.rows * 0.5, `${side.used} of ${side.rows} rows fit the curve`);
        assert.ok(side.maxResidual < 1, `${side.maxResidual} px`);
    }
    assert.ok(dome.farthest < 8);
    assert.equal(letters.subpaths, 2);
    assert.ok(letters.deviation.toRaster < 1.5 && letters.deviation.fromRaster < 1.5, JSON.stringify(letters.deviation));
});

test('the plate colours, the emblem scales and the files are reported: the lines make the emblem smaller on the circle', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runLogoPlates(request(rootDir, inPath));
    assert.deepEqual(result.colours, plateColours('#8b64aa'));
    // This small logo is wider with its lines than it is tall, so they shrink it on the square too; the real one is taller than wide.
    assert.ok(result.placements.S.withLines.scale <= result.placements.S.withoutLines.scale);
    assert.ok(result.placements.C.withLines.scale < result.placements.C.withoutLines.scale);
    const plate = readFileSync(join(rootDir, 'out', 's4', 'plates', 'logo-plate-C-D.svg'), 'utf8');
    assert.deepEqual(fills(plate), [result.colours.D.lip, result.colours.D.plate, '#8b64aa', '#593c67', '#ab8bbb']);
    assert.match(plate, /<g clip-path="url\(#c\)"><use href="#o" fill="#240f33" y="-30\.72"\/><\/g>/);
    assert.ok(result.files.every(({ bytes, gzipBytes }) => bytes > gzipBytes && gzipBytes > 0));
});

test('a real run logs the files as one derived output with the source hash and every file hash', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runLogoPlates(request(rootDir, inPath, { preview: false, outDir: join(rootDir, 'raw', 's4', 'plates') }));
    const [entry, ...rest] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.equal(rest.length, 0);
    assert.deepEqual([entry.stage, entry.provider, entry.template, entry.estimatedUsd], ['s4', 'local', 'logo-plates', 0]);
    assert.deepEqual(entry.refs, [sha256(readFileSync(inPath))]);
    assert.equal(entry.vars.source, 'approved/logo.png');
    assert.equal(entry.vars.shading, 'b');
    assert.equal(entry.vars.tracing.tracer, 'potrace');
    assert.equal(entry.vars.domeEdge.degree, 4);
    assert.equal(entry.outputs.length, 10);
    for (const { file, sha256: hash } of entry.outputs) {
        assert.equal(sha256(readFileSync(join(rootDir, file))), hash, file);
    }
    assert.equal(result.outputs.length, 10);
});

test('the band widths can be set', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runLogoPlates(request(rootDir, inPath, { kDark: 3, kLight: 2 }));
    assert.deepEqual(result.bands, { dark: 3, light: 2 });
});

test('a preview outside out/ is refused, and a second run into the same folder is refused before anything is written', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    await assert.rejects(runLogoPlates(request(rootDir, inPath, { outDir: join(rootDir, 'raw', 's4', 'plates') })), /under out\//);
    assert.ok(!existsSync(join(rootDir, 'raw', 's4', 'plates')));
    await runLogoPlates(request(rootDir, inPath));
    await assert.rejects(runLogoPlates(request(rootDir, inPath)), /already exists/);
});

test('a trace that is far from the picture is refused as broken, and nothing is written or logged', async () => {
    const { rootDir, inPath } = await workspace();
    // A tracer that answers every bitmap with the same small square.
    const fake = join(rootDir, 'fake-potrace');
    writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\necho \'<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(0,400) scale(0.01,-0.01)"><path d="M0 0 l1000 0 l0 1000 l-1000 0 z"/></g></svg>\' > "$2"\n');
    chmodSync(fake, 0o755);
    await assert.rejects(runLogoPlates(request(rootDir, inPath, { potrace: fake, preview: false, outDir: join(rootDir, 'raw', 's4', 'plates') })), /is broken; nothing was written/);
    assert.ok(!existsSync(join(rootDir, 'raw', 's4', 'plates')));
    assert.ok(!existsSync(join(rootDir, 'log')));
});

test('a logo with no lines in it is refused rather than drawn without them', needsPotrace, async () => {
    const dome = createRaster(120, 120);
    for (let y = 40; y < 100; y++) {
        for (let x = 20; x < 100; x++) {
            setPixel(dome, x, y, MID);
        }
    }
    for (let y = 90; y < 100; y++) {
        for (let x = 20; x < 100; x++) {
            setPixel(dome, x, y, DARK);
        }
    }
    for (let y = 40; y < 50; y++) {
        for (let x = 20; x < 100; x++) {
            setPixel(dome, x, y, LIGHT);
        }
    }
    const { rootDir, inPath } = await workspace(dome);
    await assert.rejects(runLogoPlates(request(rootDir, inPath)), /no lines/i);
    assert.ok(!existsSync(join(rootDir, 'out', 's4', 'plates')));
});

test('a run for one chosen plate writes the four final files under their plain names, no sheet unless asked, and logs the choice', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const outDir = join(rootDir, 'raw', 's4', 'final');
    const result = await runLogoPlates(request(rootDir, inPath, { ...CHOICE, preview: false, outDir, sheetPath: undefined, kDark: 3, kLight: 2 }));
    assert.deepEqual(result.files.map(({ file }) => file.split('/').pop()), FINAL_OUTPUTS);
    assert.deepEqual(readdirSync(outDir).sort(), [...FINAL_OUTPUTS].sort());
    assert.equal(result.sheet, undefined);
    assert.ok(!existsSync(join(rootDir, 'out')), 'no contact sheet');
    assert.deepEqual(fills(readFileSync(join(outDir, 'logo-plate.svg'), 'utf8')), ['#e4d2f5', '#f5e9ff', '#8b64aa', '#593c67', '#ab8bbb']);
    const [entry, ...rest] = readLog(join(rootDir, 'log', 'generations.jsonl'));
    assert.equal(rest.length, 0, 'one line for the whole run');
    assert.deepEqual(entry.refs, [sha256(readFileSync(inPath))]);
    assert.deepEqual(entry.outputs.map(({ file }) => file), FINAL_OUTPUTS.map((name) => `raw/s4/final/${name}`));
    for (const { file, sha256: hash } of entry.outputs) {
        assert.equal(sha256(readFileSync(join(rootDir, file))), hash, file);
    }
    assert.deepEqual(
        { shapes: entry.vars.shapes, squircleExponent: entry.vars.squircleExponent, colours: entry.vars.colours, kDark: entry.vars.kDark, kLight: entry.vars.kLight, lineWidth: entry.vars.lineWidth },
        { shapes: ['squircle'], squircleExponent: 5, colours: { light: { name: 'pale lavender', plate: '#f5e9ff', lip: '#e4d2f5' } }, kDark: 3, kLight: 2, lineWidth: 7 },
    );
    assert.equal(entry.vars.dotRadius, Math.round(result.dotRadius * 100) / 100);
    assert.equal(entry.vars.centring, 'base');
    assert.equal(entry.vars.shading, 'b');
});

test('a chosen plate keeps the S-L plate colours, and the circle and dark choices are written under the same names', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const outDir = join(rootDir, 'out', 's4', 'dark-circle');
    const result = await runLogoPlates(request(rootDir, inPath, { shape: 'circle', colour: 'dark', outDir, sheetPath: undefined }));
    assert.deepEqual(result.files.map(({ file }) => file.split('/').pop()), FINAL_OUTPUTS);
    assert.deepEqual(Object.keys(result.placements), ['C']);
    assert.deepEqual(fills(readFileSync(join(outDir, 'logo-plate-nolines.svg'), 'utf8')).slice(0, 2), [result.colours.D.lip, result.colours.D.plate]);
});

test('only one of the shape and the colour narrows the run to that column of plates, which then carry the id in their names', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const result = await runLogoPlates(request(rootDir, inPath, { colour: 'light', sheetPath: undefined }));
    assert.deepEqual(result.files.map(({ file }) => file.split('/').pop()).sort(), ['logo-emblem-nolines.svg', 'logo-emblem.svg', 'logo-plate-C-L-nolines.svg', 'logo-plate-C-L.svg', 'logo-plate-S-L-nolines.svg', 'logo-plate-S-L.svg']);
});

test('a shape or a colour that does not exist is refused before anything is read or written', async () => {
    const { rootDir, inPath } = await workspace();
    await assert.rejects(runLogoPlates(request(rootDir, inPath, { shape: 'hexagon' })), /shape must be squircle or circle/);
    await assert.rejects(runLogoPlates(request(rootDir, inPath, { colour: 'red' })), /colour light or dark/);
    assert.ok(!existsSync(join(rootDir, 'out')));
});

test('a file over the size limit stops the run before anything is written or logged', needsPotrace, async () => {
    const { rootDir, inPath } = await workspace();
    const outDir = join(rootDir, 'raw', 's4', 'final');
    await assert.rejects(runLogoPlates(request(rootDir, inPath, { ...CHOICE, preview: false, outDir, sheetPath: undefined, maxBytes: 1000 })), /bytes, which is not under 1000/);
    assert.ok(!existsSync(outDir));
    assert.ok(!existsSync(join(rootDir, 'log')));
});

test('the command refuses band widths that are not whole pixels and a missing picture before it reads anything', () => {
    const run = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    for (const [flag, value] of [['--k-dark', '0'], ['--k-light', '2.5'], ['--k-dark', 'wide']]) {
        const outcome = run(['--in', 'missing.png', flag, value, '--preview']);
        assert.equal(outcome.status, 1, flag);
        assert.match(outcome.stderr, new RegExp(`${flag} must be a whole number of pixels, 1 or more`));
    }
    assert.match(run(['--in', 'missing.png', '--shape', 'hexagon', '--preview']).stderr, /shape must be squircle or circle/);
    assert.match(run([]).stderr, /Usage: logo-plates\.mjs/);
});
