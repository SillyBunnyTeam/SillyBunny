import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeIco, readIco, readPngHeader } from '../scripts/lib/ico.mjs';
import { coverageDraft, platformSvg, reachFromCentre, renderPng } from '../scripts/lib/icon-render.mjs';
import { APPLE_SIZES, BRAND_SIZES, ICO_FILES, ICO_SIZES, ICON_SIZES, MASKABLE_PATH, buildIconSet, findPublicMismatches, planTargets } from '../scripts/lib/icon-set.mjs';
import { runIcons } from '../scripts/lib/icons-run.mjs';
import { applyPixelPatch, parsePixelPatch } from '../scripts/lib/pixel-patch.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PUBLIC = join(ROOT, '..', '..', 'public');
const SVG_NAMES = ['logo-plate.svg', 'logo-plate-nolines.svg', 'logo-emblem.svg', 'logo-emblem-nolines.svg'];
// The five tones of the logo: the plate, its lip, and the emblem's mid, dark and light.
const BRAND_TONES = ['#f5e9ff', '#e4d2f5', '#8b64aa', '#5b3c6b', '#b393c6'];

const svg = (name) => readFileSync(join(ROOT, 'approved', name), 'utf8');
const svgs = { plate: svg('logo-plate.svg'), plateNolines: svg('logo-plate-nolines.svg'), emblem: svg('logo-emblem.svg'), emblemNolines: svg('logo-emblem-nolines.svg') };
const patchText = (size) => JSON.parse(readFileSync(join(ROOT, 'fixes', `logo-${size}.json`), 'utf8'));
const patchesFor = (draft) => ({ 16: parsePixelPatch(patchText(16), draft[16]), 32: parsePixelPatch(patchText(32), draft[32]) });
const decode = async (png) => {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
};
const hex = (data, at) => `#${[0, 1, 2].map((offset) => data[at + offset].toString(16).padStart(2, '0')).join('')}`;

const drafts = { 16: await coverageDraft(svgs.plateNolines, 16), 32: await coverageDraft(svgs.plateNolines, 32) };
const patches = patchesFor(drafts);
const files = await buildIconSet({ svgs, patches });
const sizeOf = (path) => readPngHeader(files.get(path));

after(() => {
    rmSync(join(ROOT, 'out', 'test-tmp'), { recursive: true, force: true });
});

test('the set writes exactly the files and sizes the pages and the manifest already name, plus the new sillybunny folder', () => {
    const expected = [
        'img/sillybunny/logo.svg',
        ...BRAND_SIZES.map((size) => `img/sillybunny/logo-${size}.png`),
        MASKABLE_PATH,
        ...ICO_FILES,
        'img/logo.png',
        ...[16, 24, 32, 48, 64, 96, 128, 256, 512].map((size) => `img/icon-${size}x${size}.png`),
        ...[57, 72, 114, 144, 180, 192, 512].map((size) => `img/apple-icon-${size}x${size}.png`),
    ];
    assert.deepEqual([...files.keys()], expected);
    assert.deepEqual(BRAND_SIZES, [16, 32, 48, 64]);
    assert.equal(MASKABLE_PATH, 'img/sillybunny/maskable-512.png');
});

test('every file the set replaces exists in public/ at the same size, and the manifest names only files the set writes', async () => {
    assert.deepEqual(await findPublicMismatches(REPO_PUBLIC), []);
});

test('every PNG is exactly as large as its name says, and logo.png is 256', () => {
    for (const { path, kind, size } of planTargets()) {
        if (kind === 'plate' || kind === 'platform') {
            assert.deepEqual([sizeOf(path).width, sizeOf(path).height], [size, size], path);
        }
    }
    assert.deepEqual([sizeOf('img/logo.png').width, sizeOf('img/sillybunny/logo-48.png').width], [256, 48]);
});

test('plate icons have an alpha channel with empty corners; apple icons and the maskable icon are opaque, with no alpha channel at all', async () => {
    for (const size of ICON_SIZES) {
        const { data } = await decode(files.get(`img/icon-${size}x${size}.png`));
        assert.equal(readPngHeader(files.get(`img/icon-${size}x${size}.png`)).colourType, 6, `icon-${size}`);
        assert.equal(data[3], 0, `icon-${size} corner`);
    }
    for (const path of [MASKABLE_PATH, ...APPLE_SIZES.map((size) => `img/apple-icon-${size}x${size}.png`)]) {
        assert.equal(readPngHeader(files.get(path)).colourType, 2, `${path} has no alpha channel`);
        const { data, width } = await decode(files.get(path));
        assert.equal(hex(data, 0), '#f5e9ff', `${path} corner is the plate colour`);
        assert.equal(hex(data, (width * width - 1) * 4), '#f5e9ff');
    }
});

test('the lines show from 64 px up: 48 px and below match the no-lines plate, 64 px and above match the plate with lines', async () => {
    assert.deepEqual(files.get('img/icon-48x48.png'), await renderPng(svgs.plateNolines, 48));
    assert.deepEqual(files.get('img/icon-24x24.png'), await renderPng(svgs.plateNolines, 24));
    for (const size of [64, 96, 128, 256, 512]) {
        assert.deepEqual(files.get(`img/icon-${size}x${size}.png`), await renderPng(svgs.plate, size), `icon-${size}`);
    }
    assert.notDeepEqual(files.get('img/icon-64x64.png'), await renderPng(svgs.plateNolines, 64));
    assert.deepEqual(files.get('img/logo.png'), files.get('img/icon-256x256.png'));
    assert.deepEqual(files.get('img/sillybunny/logo-64.png'), files.get('img/icon-64x64.png'));
    assert.deepEqual(files.get('img/sillybunny/logo-48.png'), files.get('img/icon-48x48.png'));
});

test('platform icons use the emblem with lines from 64 px up and the one without below, inside the same safe zone', async () => {
    const platform = async (plate, emblem, size) => renderPng(platformSvg({ plate, emblem, reach: await reachFromCentre(emblem) }), size, { opaque: true });
    assert.deepEqual(files.get('img/apple-icon-57x57.png'), await platform(svgs.plateNolines, svgs.emblemNolines, 57));
    assert.deepEqual(files.get('img/apple-icon-72x72.png'), await platform(svgs.plate, svgs.emblem, 72));
    assert.deepEqual(files.get(MASKABLE_PATH), await platform(svgs.plate, svgs.emblem, 512));
    assert.deepEqual(files.get('img/apple-icon-512x512.png'), files.get(MASKABLE_PATH));
});

test('the emblem of the maskable icon stays inside the central 80% circle', async () => {
    const { data, width } = await decode(files.get(MASKABLE_PATH));
    let farthest = 0;
    for (let y = 0; y < width; y++) {
        for (let x = 0; x < width; x++) {
            if (hex(data, (y * width + x) * 4) !== '#f5e9ff') {
                farthest = Math.max(farthest, Math.hypot(Math.max(Math.abs(x - width / 2), Math.abs(x + 1 - width / 2)), Math.max(Math.abs(y - width / 2), Math.abs(y + 1 - width / 2))));
            }
        }
    }
    assert.ok(farthest <= width * 0.4, `${farthest} px from the centre, the circle's radius is ${width * 0.4}`);
});

test('the three ICO files are the same bytes, hold sizes 16, 24, 32, 48, 64, 128 and 256, and every entry is the matching icon PNG', () => {
    const [first, ...others] = ICO_FILES.map((path) => files.get(path));
    others.forEach((other) => assert.deepEqual(other, first));
    const entries = readIco(first);
    assert.deepEqual(entries.map(({ width }) => width), ICO_SIZES);
    assert.ok(entries.every(({ width, height, bitCount, format }) => width === height && bitCount === 32 && format === 'png'));
    for (const entry of entries) {
        assert.deepEqual(entry.data, files.get(`img/icon-${entry.width}x${entry.width}.png`), `${entry.width} px entry`);
    }
});

test('the patches apply to the drafts: the 16 and 32 px icons are the patched drafts, and the patch changes pixels', async () => {
    for (const size of [16, 32]) {
        const { raster, changed } = applyPixelPatch(drafts[size], patches[size]);
        assert.ok(changed > 0, `the ${size} px patch changes nothing`);
        const built = await decode(files.get(`img/icon-${size}x${size}.png`));
        assert.deepEqual(Buffer.from(built.data), Buffer.from(raster.data), `icon-${size}`);
        assert.deepEqual(files.get(`img/sillybunny/logo-${size}.png`), files.get(`img/icon-${size}x${size}.png`));
        assert.notDeepEqual(Buffer.from(built.data), Buffer.from(drafts[size].data));
    }
});

test('the patches paint only the logo tones or transparent, and leave the emblem with no half-tones', async () => {
    for (const size of [16, 32]) {
        for (const edit of patchText(size)) {
            assert.ok([...BRAND_TONES, 'transparent'].includes(edit.color), `${size} px patch paints ${edit.color}`);
        }
        const { data, width } = await decode(files.get(`img/icon-${size}x${size}.png`));
        const margin = size / 8;
        for (let y = margin; y < width - margin; y++) {
            for (let x = margin; x < width - margin; x++) {
                const at = (y * width + x) * 4;
                assert.equal(data[at + 3], 255, `${size} px: pixel ${x},${y} is not solid`);
                assert.ok(BRAND_TONES.includes(hex(data, at)), `${size} px: pixel ${x},${y} is ${hex(data, at)}, which is not a logo tone`);
            }
        }
    }
});

test('only 16 and 32 px are hand work: 24 and 48 px are direct renders of the SVG, and 16 and 32 px are not', async () => {
    for (const size of [24, 48]) {
        assert.deepEqual(files.get(`img/icon-${size}x${size}.png`), await renderPng(svgs.plateNolines, size), `${size} px`);
    }
    for (const size of [16, 32]) {
        assert.notDeepEqual(files.get(`img/icon-${size}x${size}.png`), await renderPng(svgs.plateNolines, size), `${size} px`);
    }
});

/** The plate with its drawing moved by whole 16 px icon pixels (64 units each), so the area-coverage draft no longer lines up with the pixel-fix. */
const shifted = (svg, columns, rows) => svg.replace(/(<svg[^>]*>)/, `$1<g transform="translate(${columns * 64} ${rows * 64})">`).replace('</svg>', '</g></svg>');

test('a pixel-fix that does not fit its draft stops the build: moved drawing, moved edit, and a leftover edit all name the size', async () => {
    const moved = { ...svgs, plateNolines: shifted(svgs.plateNolines, 1, 0) };
    await assert.rejects(buildIconSet({ svgs: moved, patches }), /The (16|32) px (pixel-fix lists \d+ pixels but changes \d+|icon has #[0-9a-f]{6} at alpha \d+ in pixel)/);
    const edit = patchText(16)[0];
    const edits = [{ ...edit, x: edit.x + 1 }, ...patchText(16).slice(1)];
    await assert.rejects(buildIconSet({ svgs, patches: { ...patches, 16: parsePixelPatch(edits, drafts[16]) } }), /The 16 px (pixel-fix lists|icon has)/);
    const redundant = [...patchText(16), { x: 0, y: 0, color: 'transparent' }];
    await assert.rejects(buildIconSet({ svgs, patches: { ...patches, 16: parsePixelPatch(redundant, drafts[16]) } }), /The 16 px pixel-fix lists 86 pixels but changes 85/);
});

test('a stale pixel-fix stops a write run before anything is written or logged', async () => {
    const { root, publicDir } = await workspace();
    writeFileSync(join(root, 'approved', 'logo-plate-nolines.svg'), shifted(svgs.plateNolines, 1, 0));
    await assert.rejects(runIcons({ rootDir: root, publicDir, outDir: 'out/icons', write: true }), /pixel-fix/);
    assert.ok(!existsSync(join(root, 'log')));
    assert.ok(!existsSync(join(root, 'out', 'icons', 'public')));
});

test('logo.svg is a byte for byte copy of the approved plate with lines', () => {
    assert.equal(files.get('img/sillybunny/logo.svg').toString('utf8'), svgs.plate);
});

/** A root with the approved logo and the patches, an empty log folder, and a public folder that matches the set. */
async function workspace({ breakFile, breakManifest } = {}) {
    const root = tempDir('sb-icons-');
    mkdirSync(join(root, 'approved'));
    for (const name of SVG_NAMES) {
        cpSync(join(ROOT, 'approved', name), join(root, 'approved', name));
    }
    cpSync(join(ROOT, 'fixes'), join(root, 'fixes'), { recursive: true });
    const publicDir = join(root, 'public');
    for (const target of planTargets().filter(({ replaces }) => replaces)) {
        const { path } = target;
        mkdirSync(dirname(join(publicDir, path)), { recursive: true });
        const size = path === breakFile ? 31 : target.size;
        const stub = target.kind === 'ico'
            ? encodeIco(await Promise.all(ICO_SIZES.map(async (entry) => ({ size: entry, png: await sharp({ create: { width: entry, height: entry, channels: 4, background: '#000000' } }).png().toBuffer() }))))
            : await sharp({ create: { width: size, height: size, channels: 4, background: '#000000' } }).png().toBuffer();
        writeFileSync(join(publicDir, path), stub);
    }
    const manifest = JSON.parse(readFileSync(join(REPO_PUBLIC, 'manifest.json'), 'utf8'));
    if (breakManifest) {
        manifest.icons.push({ src: 'img/no-such-icon.png', sizes: '64x64', type: 'image/png' });
    }
    writeFileSync(join(publicDir, 'manifest.json'), JSON.stringify(manifest));
    return { root, publicDir };
}

const listFiles = (directory) => readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

test('a preview run writes the set, the drafts and the sheets under out/ and leaves public/ and the log alone', async () => {
    const { root, publicDir } = await workspace();
    const before = listFiles(publicDir).map((path) => [path, readFileSync(path)]);
    const result = await runIcons({ rootDir: root, publicDir, outDir: 'out/icons' });
    assert.equal(result.wrote, false);
    assert.ok(!existsSync(join(root, 'log')), 'nothing was logged');
    for (const [path, bytes] of before) {
        assert.deepEqual(readFileSync(path), bytes, `${path} was touched`);
    }
    assert.deepEqual(result.files.map(({ path }) => path), [...files.keys()]);
    for (const { path, bytes } of result.files) {
        assert.deepEqual(readFileSync(join(root, 'out', 'icons', 'public', path)), files.get(path), path);
        assert.equal(bytes, files.get(path).length);
    }
    for (const name of ['draft-16', 'draft-24', 'draft-32', 'draft-48', 'patched-16', 'patched-32']) {
        assert.ok(existsSync(join(root, 'out', 'icons', 'drafts', `${name}.png`)), name);
    }
    for (const name of ['drafts', 'patches', 'sizes']) {
        assert.ok((await sharp(join(root, 'out', 'icons', 'sheets', `${name}.png`)).metadata()).width >= 900, name);
    }
    assert.deepEqual(result.patches[16].edits, patchText(16).length);
});

test('a write run replaces the files in public/ and adds one log line with a hash for each', async () => {
    const { root, publicDir } = await workspace();
    const result = await runIcons({ rootDir: root, publicDir, outDir: 'out/icons', write: true, now: () => new Date('2026-11-02T10:00:00Z') });
    assert.equal(result.wrote, true);
    for (const [path, bytes] of files) {
        assert.deepEqual(readFileSync(join(publicDir, path)), bytes, path);
    }
    const lines = readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual([entry.template, entry.provider, entry.stage, entry.approved, entry.estimatedUsd, entry.time], ['icons', 'local', 's4', false, 0, '2026-11-02T10:00:00.000Z']);
    assert.equal(entry.outputs.length, files.size);
    assert.equal(entry.refs.length, 4);
    assert.deepEqual(Object.keys(entry.vars.patches), ['fixes/logo-16.json', 'fixes/logo-32.json']);
    assert.ok(entry.outputs.every(({ file, sha256 }) => file.startsWith('public/') && /^[0-9a-f]{64}$/.test(sha256)));
    assert.deepEqual((await findPublicMismatches(publicDir)), [], 'a second run still finds the names and sizes it wrote');
});

test('a file in public/ with another size, or a manifest icon the set does not write, stops the run before anything is written or logged', async () => {
    for (const [options, message] of [
        [{ breakFile: 'img/icon-32x32.png' }, /img\/icon-32x32\.png is 31x31; the set writes 32x32/],
        [{ breakManifest: true }, /manifest\.json names img\/no-such-icon\.png/],
    ]) {
        const { root, publicDir } = await workspace(options);
        await assert.rejects(runIcons({ rootDir: root, publicDir, outDir: 'out/icons', write: true }), message);
        assert.ok(!existsSync(join(root, 'log')));
        assert.ok(!existsSync(join(root, 'out', 'icons', 'public')));
    }
});

test('a missing file to replace is named', async () => {
    const { root, publicDir } = await workspace();
    rmSync(join(publicDir, 'st.ico'));
    await assert.rejects(runIcons({ rootDir: root, publicDir, outDir: 'out/icons' }), /st\.ico is missing/);
});

test('a missing patch or an edit outside the picture is refused with the patch file named', async () => {
    const { root, publicDir } = await workspace();
    writeFileSync(join(root, 'fixes', 'logo-16.json'), JSON.stringify([{ x: 16, y: 0, color: '#8b64aa' }]));
    await assert.rejects(runIcons({ rootDir: root, publicDir, outDir: 'out/icons' }), /logo-16\.json: edit 1: .* outside the 16x16 picture/);
    rmSync(join(root, 'fixes', 'logo-32.json'));
    writeFileSync(join(root, 'fixes', 'logo-16.json'), JSON.stringify([{ x: 1, y: 1, color: '#8b64aa' }]));
    await assert.rejects(runIcons({ rootDir: root, publicDir, outDir: 'out/icons' }), /pixel-fix patch could not be read/);
});

test('output outside out/ and raw/ is refused', async () => {
    const { root, publicDir } = await workspace();
    await assert.rejects(runIcons({ rootDir: root, publicDir, outDir: 'public' }), /inside raw\/ or out\//);
});

test('the command previews into the folder it is given and says that public/ and the log are untouched', () => {
    const outcome = spawnSync('node', [join(ROOT, 'scripts', 'icons.mjs'), '--out-dir', join('out', 'test-tmp', `icons-${process.pid}`)], { encoding: 'utf8', cwd: ROOT });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /16 px: \d+ edits on the draft, \d+ pixels changed/);
    assert.match(outcome.stdout, /img\/icon-16x16\.png\s+\d+ bytes/);
    assert.match(outcome.stdout, /preview only/);
    assert.ok(existsSync(join(ROOT, 'out', 'test-tmp', `icons-${process.pid}`, 'public', 'favicon.ico')));
    const refused = spawnSync('node', [join(ROOT, 'scripts', 'icons.mjs'), '--out-dir', '../public'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /inside raw\/ or out\//);
});

test('--help prints the usage on stdout and exits 0 without building anything', () => {
    const outcome = spawnSync('node', [join(ROOT, 'scripts', 'icons.mjs'), '--help'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /^Usage: icons\.mjs /);
    assert.equal(outcome.stderr, '');
    assert.doesNotMatch(outcome.stdout, /wrote|preview only/);
});
