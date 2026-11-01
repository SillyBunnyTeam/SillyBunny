import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { sniffImage } from './images.mjs';
import { centreOfMassX, findBase, frameEmblem, placeInFrame } from './logo-frame.mjs';
import { buildLogoSheet } from './logo-sheet.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { THIN_SHARE, isolateLines, lineThickness, measureShading, rasterFromTones, shadeLines, toneRoles } from './line-shading.mjs';
import { cutLetters, findHoles, holesCentreRow, paintHoles, reduceByCoverage } from './pixel-draft.mjs';
import { opaqueBox, readRaster, writeRaster } from './raster.mjs';
import { resolveOutDir } from './run.mjs';
import { dilateMask, dropThinParts } from './shape-ops.mjs';
import { findTones, pinTone, snapToTones } from './tone-snap.mjs';
import { parsePath, readVtracerPaths, serialisePath, translatePath } from './vector-path.mjs';

export const CENTRINGS = ['base', 'bbox'];
// The pixel drafts: all centred on the dome, with the ears and the dome only (no lines, no charms). The 16 has no room for letters.
export const PIXEL_DRAFTS = [
    { name: 'pixel-16', label: '16 px, solid dome', grid: 16, letters: false },
    { name: 'pixel-32-sb', label: '32 px, SB cut out', grid: 32, letters: true },
    { name: 'pixel-32-solid', label: '32 px, solid dome', grid: 32, letters: false },
];
// Shorter segments follow the source's wobble; longer ones give a smoother curve and a smaller file.
export const SEGMENT_LENGTH = 8;
// The bands on the lines and dots, as a share of the line's thickness: the dark lower edge is a third of it, the light upper edge a fifth,
// which leaves the line a middle of base tone. The dome's own bands are 18 and 24 px on a dome 250 px tall, which a 19 px line cannot hold.
export const DARK_BAND_SHARE = 1 / 3;
export const LIGHT_BAND_SHARE = 1 / 5;
export const LINE_VARIANTS = [
    { id: 'a', label: 'A: dark lower edge', light: false },
    { id: 'b', label: 'B: dark lower edge and light upper edge', light: true },
];
// A trace that is wrong by more than a pixel over this share of its shape is broken (a missing layer is over 10%), not rough (the logo master is under 1%).
const MAX_SHAPE_MISMATCH = 0.04;
const TRACE_ARGUMENTS = ['--colormode', 'color', '--hierarchical', 'stacked', '--mode', 'spline', '--filter_speckle', '4', '--color_precision', '8', '--path_precision', '1'];

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/** The vtracer binary: $VTRACER, else cargo's install directory, else the PATH. */
export function findVtracer(env = process.env) {
    const candidates = [env.VTRACER, join(env.HOME ?? homedir(), '.cargo', 'bin', 'vtracer'), 'vtracer'].filter(Boolean);
    const found = candidates.find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0);
    if (!found) {
        throw new Error('vtracer was not found. Install it with `cargo install vtracer` or set VTRACER to its path.');
    }
    return found;
}

/**
 * Traces one tone: only its pixels (every opaque pixel for the base layer, which is drawn underneath so no gap can open between
 * tones) go to vtracer, and all the paths it returns are merged into one list of commands in source coordinates.
 */
export async function traceLayer({ raster, toneIndex, belongs }, { vtracer, segmentLength, directory }) {
    const data = Buffer.alloc(raster.data.length);
    for (let at = 0; at < toneIndex.length; at++) {
        if (toneIndex[at] >= 0 && belongs(toneIndex[at])) {
            data.set([0, 0, 0, 255], at * 4);
        }
    }
    const input = join(directory, 'layer.png');
    const output = join(directory, 'layer.svg');
    await writeRaster(input, { width: raster.width, height: raster.height, data });
    const result = spawnSync(vtracer, [...TRACE_ARGUMENTS, '--segment_length', String(segmentLength), '-i', input, '-o', output], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`vtracer failed: ${(result.stderr || result.stdout).trim().split('\n').find((line) => /error|panick/i.test(line)) ?? 'no message'}`);
    }
    return readVtracerPaths(readFileSync(output, 'utf8')).flatMap(({ d, dx, dy }) => translatePath(parsePath(d), dx, dy));
}

/** A palette PNG, which is lossless for a picture of a few flat tones and tiny for a pixel version. */
const indexedPng = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png({ palette: true, colours: 256, dither: 0, compressionLevel: 9 }).toBuffer();

/** Flat SVG: one path per tone, no metadata, no fixed size, and the viewBox starting at 0 0. */
export function buildSvg({ width, height, layers, offsetX = 0, offsetY = 0 }) {
    const paths = layers.map(({ fill, commands }) => `<path fill="${fill}" d="${serialisePath(translatePath(commands, offsetX, offsetY))}"/>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${paths.join('')}</svg>\n`;
}

/**
 * How far a rendered trace is from the snapped picture it came from: the share of the shape that is wrong by more than a pixel
 * (a boundary a pixel out is the trace being a curve, not a mistake), and the share of fully covered pixels that have another tone.
 */
export async function compareTrace(svg, snapped, tones, toneIndex) {
    const { width, height } = snapped;
    const rendered = await sharp(Buffer.from(svg), { density: 72 }).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    const wanted = Uint8Array.from(toneIndex, (tone) => (tone >= 0 ? 1 : 0));
    const drawn = Uint8Array.from({ length: wanted.length }, (_, at) => (rendered[at * 4 + 3] >= 128 ? 1 : 0));
    const nearWanted = dilateMask(wanted, width, height, 1);
    const nearDrawn = dilateMask(drawn, width, height, 1);
    let shape = 0;
    let wrongShape = 0;
    let wrongTone = 0;
    for (let at = 0; at < wanted.length; at++) {
        shape += wanted[at];
        wrongShape += (wanted[at] === 1 && nearDrawn[at] === 0) || (drawn[at] === 1 && nearWanted[at] === 0) ? 1 : 0;
        if (wanted[at] === 1 && rendered[at * 4 + 3] >= 250) {
            const expected = tones[toneIndex[at]].rgb;
            wrongTone += Math.abs(rendered[at * 4] - expected[0]) + Math.abs(rendered[at * 4 + 1] - expected[1]) + Math.abs(rendered[at * 4 + 2] - expected[2]) > 30 ? 1 : 0;
        }
    }
    return { wrongShape: wrongShape / shape, wrongTone: wrongTone / shape };
}

/**
 * Turns the approved logo master into flat SVGs (one per centring) and first-pass pixel drafts, previews them, and, unless this is a
 * preview, logs the files as derived outputs (no model call, so it costs nothing; the source's sha256 is in `refs`).
 *
 * The master is first snapped to the tones it is drawn in, with the one nearest `baseHex` set to exactly that colour; each tone is
 * traced on its own with vtracer (the base tone under everything else) and merged into one path.
 * The pixel drafts take the ears and the dome only, centre them on the dome, and reduce them by area coverage.
 * A `preview` run writes only under out/ and writes nothing to the log.
 * @param {{ rootDir: string, inPath: string, outDir: string, sheetPath: string, baseHex: string, centrings?: string[], drafts?: typeof PIXEL_DRAFTS, segmentLength?: number, kDark?: number, kLight?: number, vtracer?: string, preview?: boolean, now: () => Date }} request
 * `kDark` and `kLight` set the band widths on the lines and dots in pixels; by default they are a third and a fifth of the lines' thickness.
 */
export async function runVectorize({ rootDir, inPath, outDir, sheetPath, baseHex, centrings = CENTRINGS, drafts = PIXEL_DRAFTS, segmentLength = SEGMENT_LENGTH, kDark, kLight, vtracer = findVtracer(), preview = false, now }) {
    const absoluteOut = isAbsolute(outDir) ? outDir : resolve(outDir);
    resolveOutDir(rootDir, absoluteOut);
    if (preview && !toLogPath(rootDir, absoluteOut).startsWith('out/')) {
        throw new Error(`A preview is written under out/ only, not ${toLogPath(rootDir, absoluteOut)}, so it cannot be mistaken for a logged output.`);
    }
    const absoluteSheet = isAbsolute(sheetPath) ? sheetPath : resolve(sheetPath);
    resolveOutDir(rootDir, dirname(absoluteSheet));
    const names = [
        ...centrings.flatMap((centring) => ['logo-' + centring + '.svg', ...LINE_VARIANTS.map(({ id }) => `logo-${centring}-lines-${id}.svg`)]),
        ...drafts.map(({ name }) => `logo-${name}.png`),
    ];
    const existing = names.map((name) => join(absoluteOut, name)).filter(existsSync);
    if (existing.length > 0) {
        throw new Error(`${toLogPath(rootDir, existing[0])} already exists; pick another --out-dir or remove it first.`);
    }

    const sourceBytes = readFileSync(inPath);
    sniffImage(sourceBytes);
    const source = await readRaster(inPath);
    const found = findTones(source);
    const tones = pinTone(found, baseHex);
    const { raster: snapped, toneIndex } = snapToTones(source, tones);
    const box = opaqueBox(snapped, 128);
    const base = findBase(snapped);
    const baseTone = tones.findIndex((tone) => tone.hex === baseHex.toLowerCase());
    // The base tone goes under the others; the rest go on top, darkest first.
    const lightness = (tone) => tone.rgb[0] * 0.2126 + tone.rgb[1] * 0.7152 + tone.rgb[2] * 0.0722;
    const stack = [baseTone, ...tones.map((_, index) => index).filter((index) => index !== baseTone).sort((a, b) => lightness(tones[a]) - lightness(tones[b]))];

    const thinWidth = Math.max(3, Math.round(Math.max(box.width, box.height) * THIN_SHARE));
    const { width, height } = snapped;
    const roles = toneRoles(tones, baseHex);
    const isolated = isolateLines(snapped, thinWidth);
    const silhouette = Uint8Array.from(toneIndex, (tone) => (tone >= 0 ? 1 : 0));
    const thickness = lineThickness(isolated.thin, silhouette, width, height);
    const bands = { dark: kDark ?? Math.max(1, Math.round(thickness * DARK_BAND_SHARE)), light: kLight ?? Math.max(1, Math.round(thickness * LIGHT_BAND_SHARE)) };
    const existingShading = measureShading({ toneIndex, width, height, roles, dome: base });
    // The plain logo and each shaded variant, as tone indexes of the same snapped picture.
    const variants = [{ id: 'plain', label: 'unshaded', toneIndex }];
    for (const variant of LINE_VARIANTS) {
        const shaded = shadeLines({ toneIndex, width, height, zone: isolated.zone, roles, kDark: bands.dark, kLight: variant.light ? bands.light : 0 });
        variants.push({ ...variant, toneIndex: shaded.toneIndex, darkened: shaded.darkened, lightened: shaded.lightened });
    }

    const directory = mkdtempSync(join(tmpdir(), 'sb-vectorize-'));
    try {
        for (const variant of variants) {
            variant.layers = [];
            const raster = rasterFromTones(variant.toneIndex, width, height, tones);
            for (const index of stack) {
                const commands = await traceLayer({ raster, toneIndex: variant.toneIndex, belongs: index === baseTone ? () => true : (tone) => tone === index }, { vtracer, segmentLength, directory });
                variant.layers.push({ fill: tones[index].hex, commands });
            }
            variant.check = await compareTrace(buildSvg({ width, height, layers: variant.layers }), raster, tones, variant.toneIndex);
            if (variant.check.wrongShape > MAX_SHAPE_MISMATCH) {
                throw new Error(`The trace of the ${variant.label} logo differs from the snapped picture on ${(variant.check.wrongShape * 100).toFixed(1)}% of the shape, so it is broken; nothing was written.`);
            }
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
    const check = variants[0].check;

    const files = [];
    const report = [];
    const svgs = new Map();
    const frameLabel = (frame, centring) => `${frame.side} px, centred on the ${centring === 'base' ? 'SB dome' : 'bounding box'}`;
    for (const centring of centrings) {
        const frame = frameEmblem(box, base.centreX, centring);
        for (const variant of variants) {
            const svg = buildSvg({ width: frame.side, height: frame.side, layers: variant.layers, offsetX: frame.offsetX, offsetY: frame.offsetY });
            const name = variant.id === 'plain' ? `logo-${centring}.svg` : `logo-${centring}-lines-${variant.id}.svg`;
            files.push({ path: join(absoluteOut, name), bytes: Buffer.from(svg) });
            svgs.set(`${centring}/${variant.id}`, { svg, frame, label: `${name} (${frameLabel(frame, centring)})`, domeX: base.centreX + frame.offsetX, boxX: box.x + box.width / 2 + frame.offsetX });
            report.push({ centring, variant: variant.id, label: variant.label, side: frame.side, bytes: Buffer.byteLength(svg), gzipBytes: gzipSync(svg).length, file: toLogPath(rootDir, join(absoluteOut, name)) });
        }
    }

    const body = dropThinParts(snapped, { thinWidth });
    const placedBody = placeInFrame(body, frameEmblem(opaqueBox(body, 128), base.centreX, 'base'));
    const holes = findHoles(placedBody);
    const solidBody = paintHoles(placedBody, holes, tones[baseTone].rgb);
    const draftPictures = [];
    for (const draft of drafts) {
        const reduced = reduceByCoverage(solidBody, tones, draft.grid);
        const grid = draft.letters ? cutLetters(reduced, holesCentreRow(holes, placedBody.width, draft.grid)) : reduced;
        const bytes = await indexedPng(grid);
        draftPictures.push({ label: draft.label, grid: draft.grid, bytes });
        files.push({ path: join(absoluteOut, `logo-${draft.name}.png`), bytes });
    }

    const leftmost = [...isolated.parts].sort((a, b) => a.box.x - b.box.x)[0];
    const domeFrame = svgs.get('base/plain');
    const sheetContent = {
        centring: centrings.map((centring) => svgs.get(`${centring}/plain`)),
        shading: variants.filter(() => centrings.includes('base')).map(({ id, label }) => ({ ...svgs.get(`base/${id}`), label: `${label}` })),
        crops: leftmost && centrings.includes('base') ? variants.map(({ id, label }) => ({ label, svg: svgs.get(`base/${id}`).svg, box: { x: leftmost.box.x - 6 + domeFrame.frame.offsetX, y: leftmost.box.y - 6 + domeFrame.frame.offsetY, width: 120, height: 64 } })) : [],
        small: [...variants.map(({ id, label }) => ({ label: `dome-centred, ${label}`, svg: svgs.get(`base/${id}`)?.svg })), { label: 'bounding-box-centred, unshaded', svg: svgs.get('bbox/plain')?.svg }].filter(({ svg }) => svg),
        drafts: draftPictures,
    };

    // Everything is built before anything is written, so a failure above leaves no half-finished files and no log line.
    const sheet = await buildLogoSheet(sheetContent);
    mkdirSync(absoluteOut, { recursive: true });
    mkdirSync(dirname(absoluteSheet), { recursive: true });
    for (const { path, bytes } of files) {
        writeFileSync(path, bytes, { flag: 'wx' });
    }
    writeFileSync(absoluteSheet, sheet);
    const outputs = files.map(({ path, bytes }) => ({ file: toLogPath(rootDir, path), sha256: sha256(bytes) }));
    if (!preview) {
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage: 's4',
            provider: 'local',
            model: 'vectorize',
            template: 'vectorize',
            vars: {
                source: toLogPath(rootDir, resolve(inPath)),
                tones: tones.map((tone) => tone.hex),
                base: baseHex.toLowerCase(),
                mode: 'spline',
                segmentLength,
                centrings,
                drafts: drafts.map(({ name }) => name),
                thinWidth,
                lineThickness: thickness,
                bands,
            },
            refHashes: [sha256(sourceBytes)],
            size: `${snapped.width}x${snapped.height}`,
            outputs,
            estimatedUsd: 0,
        }));
    }
    const boxCentre = box.x + box.width / 2;
    return {
        found,
        tones,
        box,
        base,
        massX: centreOfMassX(snapped),
        centres: { dome: base.centreX, box: boxCentre, mass: centreOfMassX(snapped), canvas: snapped.width / 2, gap: boxCentre - base.centreX, gapShareOfBox: Math.abs(boxCentre - base.centreX) / box.width, gapShareOfCanvas: Math.abs(boxCentre - base.centreX) / snapped.width },
        check,
        thinWidth,
        lines: { parts: isolated.parts.length, thickness, bands, existingShading, shaded: variants.filter(({ id }) => id !== 'plain').map(({ id, darkened, lightened }) => ({ id, darkened, lightened })) },
        files: report,
        sheet: toLogPath(rootDir, absoluteSheet),
        outputs,
    };
}
