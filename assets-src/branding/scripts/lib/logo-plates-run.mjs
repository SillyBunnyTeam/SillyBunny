import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { orientSubpaths, outerRunsClockwise } from './geometry.mjs';
import { sniffImage } from './images.mjs';
import { edgeAt, fitLines } from './line-fit.mjs';
import { buildLineShapes } from './line-geometry.mjs';
import { THIN_SHARE, isolateLines, lineThickness, rasterFromTones, toneRoles } from './line-shading.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { findBase, frameEmblem } from './logo-frame.mjs';
import { SQUIRCLE_EXPONENT, plateColours, placeEmblem, plateSvg } from './plate.mjs';
import { buildPlateSheet } from './plate-sheet.mjs';
import { opaqueBox, readRaster } from './raster.mjs';
import { resolveOutDir } from './run.mjs';
import { dilateMask } from './shape-ops.mjs';
import { checkFinalSvg } from './svg-checks.mjs';
import { findTones, pinTone, snapToTones } from './tone-snap.mjs';
import { SEGMENT_LENGTH, buildSvg, compareTrace, findVtracer, traceLayer } from './vectorize-run.mjs';

export const SHAPES = [{ id: 'S', shape: 'square', name: 'squircle' }, { id: 'C', shape: 'circle', name: 'circle' }];
export const STYLES = [{ id: 'L', name: 'light' }, { id: 'D', name: 'dark' }];
// The bands on the lines and dots as a share of the line's width, as in the unshaded to shaded comparison the logo was chosen from.
const DARK_BAND_SHARE = 1 / 3;
const LIGHT_BAND_SHARE = 1 / 5;
// The redrawn lines may differ from the picture by this many pixels before the run says so.
const MAX_MOVE = 3;
const MAX_SHAPE_MISMATCH = 0.04;
// A pixel of the line's first stretch counts as the line's, not the dome's, up to this far past the dome's fitted edge.
const STUB_REACH = 1.5;
const STUB_ROWS = 3;

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/** The pixels of an SVG drawn at its own size, as an alpha mask (1 where at least half covered). */
async function renderMask(svg, side) {
    const data = await sharp(Buffer.from(svg), { density: 72 }).resize(side, side, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
    return Uint8Array.from({ length: side * side }, (_, at) => (data[at * 4 + 3] >= 128 ? 1 : 0));
}

/** The smallest k for which each mask lies within k pixels of the other inside `region`, up to `limit`. */
function displacement(a, b, region, width, height, limit) {
    for (let k = 0; k <= limit; k++) {
        const [nearA, nearB] = [dilateMask(a, width, height, k), dilateMask(b, width, height, k)];
        const covered = region.every((value, at) => value === 0 || ((a[at] === 0 || nearB[at] === 1) && (b[at] === 0 || nearA[at] === 1)));
        if (covered) {
            return k;
        }
    }
    return limit + 1;
}

/** The smallest box round the set pixels of a mask. */
function maskBox(mask, width, height) {
    let [left, top, right, bottom] = [width, height, -1, -1];
    mask.forEach((value, at) => {
        if (value === 1) {
            const [x, y] = [at % width, Math.floor(at / width)];
            [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
        }
    });
    if (right < 0) {
        throw new Error('The redrawn emblem is empty.');
    }
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

const boundaryCorners = (mask, side) => {
    const points = [];
    const filled = (x, y) => x >= 0 && y >= 0 && x < side && y < side && mask[y * side + x] === 1;
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            if (mask[y * side + x] === 1 && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !filled(x + dx, y + dy))) {
                points.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
            }
        }
    }
    return points;
};

/**
 * Redraws the lines and dots of the approved logo as exact geometry (a circle for each dot, a right-angled stroke of one width for each
 * line, with shading B drawn as exact edges), traces the rest, and puts the emblem on plates: a rounded square and a circle, each in a
 * pale and a deep colour made from the brand hue, with and without the lines. Everything is built before anything is written.
 * `shape` ('squircle' or 'circle') and `colour` ('light' or 'dark') keep only that choice; with a single plate left the files are named
 * logo-emblem.svg, logo-emblem-nolines.svg, logo-plate.svg and logo-plate-nolines.svg. Without a `sheetPath` no contact sheet is written.
 * Every SVG must pass `checkFinalSvg`. `preview` writes under out/ only and writes nothing to the log.
 * @param {{ rootDir: string, inPath: string, outDir: string, sheetPath?: string, baseHex: string, shape?: 'squircle' | 'circle', colour?: 'light' | 'dark', segmentLength?: number, kDark?: number, kLight?: number, maxBytes?: number, vtracer?: string, preview?: boolean, now: () => Date }} request
 */
export async function runLogoPlates({ rootDir, inPath, outDir, sheetPath, baseHex, shape: chosenShape, colour: chosenColour, segmentLength = SEGMENT_LENGTH, kDark, kLight, maxBytes, vtracer = findVtracer(), preview = false, now }) {
    const shapes = SHAPES.filter(({ name }) => chosenShape === undefined || name === chosenShape);
    const styles = STYLES.filter(({ name }) => chosenColour === undefined || name === chosenColour);
    if (shapes.length === 0 || styles.length === 0) {
        throw new Error(`The shape must be ${SHAPES.map(({ name }) => name).join(' or ')} and the colour ${STYLES.map(({ name }) => name).join(' or ')}; got ${chosenShape} and ${chosenColour}.`);
    }
    const chosen = shapes.length * styles.length === 1;
    const plateName = ({ id }, { id: style }, withLines) => `logo-plate${chosen ? '' : `-${id}-${style}`}${withLines ? '' : '-nolines'}.svg`;
    const absoluteOut = isAbsolute(outDir) ? outDir : resolve(outDir);
    resolveOutDir(rootDir, absoluteOut);
    if (preview && !toLogPath(rootDir, absoluteOut).startsWith('out/')) {
        throw new Error(`A preview is written under out/ only, not ${toLogPath(rootDir, absoluteOut)}, so it cannot be mistaken for a logged output.`);
    }
    const absoluteSheet = sheetPath === undefined ? undefined : isAbsolute(sheetPath) ? sheetPath : resolve(sheetPath);
    if (absoluteSheet) {
        resolveOutDir(rootDir, dirname(absoluteSheet));
    }
    const plateNames = shapes.flatMap((shape) => styles.flatMap((style) => [plateName(shape, style, true), plateName(shape, style, false)]));
    const names = ['logo-emblem.svg', 'logo-emblem-nolines.svg', ...plateNames];
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
    const { width, height } = snapped;
    const roles = toneRoles(tones, baseHex);
    const box = opaqueBox(snapped, 128);
    const base = findBase(snapped);
    const thinWidth = Math.max(3, Math.round(Math.max(box.width, box.height) * THIN_SHARE));
    const isolated = isolateLines(snapped, thinWidth);
    const silhouette = Uint8Array.from(toneIndex, (tone) => (tone >= 0 ? 1 : 0));
    const thickness = lineThickness(isolated.thin, silhouette, width, height);
    const fits = fitLines({ silhouette, lines: isolated.thin, zone: isolated.zone, width, height, thickness });
    const lineWidth = fits[0].width;
    const bands = { dark: kDark ?? Math.max(1, Math.round(lineWidth * DARK_BAND_SHARE)), light: kLight ?? Math.max(1, Math.round(lineWidth * LIGHT_BAND_SHARE)) };

    // The ears and the dome are traced without the lines, dots and the first pixels of each line at the dome, which are drawn as geometry.
    const bodyIndex = Int8Array.from(toneIndex, (tone, at) => (isolated.thin[at] === 1 ? -1 : tone));
    // Where a line meets the dome, the line's own first pixels go: inside the stroke's rows up to a little past the dome's fitted edge,
    // and just above and below it only what sticks out past the edge, so the dome keeps its own outline there.
    fits.forEach(({ vertices, width: strokeWidth, towards, edge }) => {
        const row = vertices[vertices.length - 1][1];
        for (let y = row - strokeWidth / 2 - STUB_ROWS; y < row + strokeWidth / 2 + STUB_ROWS; y++) {
            const inStroke = y >= row - strokeWidth / 2 && y < row + strokeWidth / 2;
            const reach = inStroke ? STUB_REACH : 0.5;
            for (let x = 0; x < width; x++) {
                const onDotSide = towards === 1 ? x < edgeAt(edge, y) + reach : x + 1 > edgeAt(edge, y) - reach;
                if (onDotSide && isolated.zone[y * width + x] === 1) {
                    bodyIndex[y * width + x] = -1;
                }
            }
        }
    });
    const bodyRaster = rasterFromTones(bodyIndex, width, height, tones);
    const toneOrder = [roles.base, roles.dark, roles.light];
    const directory = mkdtempSync(join(tmpdir(), 'sb-plates-'));
    let bodyLayers;
    try {
        bodyLayers = [];
        for (const index of toneOrder) {
            const commands = await traceLayer({ raster: bodyRaster, toneIndex: bodyIndex, belongs: index === roles.base ? () => true : (tone) => tone === index }, { vtracer, segmentLength, directory });
            bodyLayers.push({ fill: tones[index].hex, commands });
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
    const bodyCheck = await compareTrace(buildSvg({ width, height, layers: bodyLayers }), bodyRaster, tones, bodyIndex);
    if (bodyCheck.wrongShape > MAX_SHAPE_MISMATCH) {
        throw new Error(`The trace of the ears and dome differs from the picture on ${(bodyCheck.wrongShape * 100).toFixed(1)}% of the shape, so it is broken; nothing was written.`);
    }

    // Subpaths of the line shapes run the way the traced outline does, so where they overlap the dome they add up instead of cancelling.
    const clockwise = outerRunsClockwise(bodyLayers[0].commands);
    const lineShapes = fits.map((fit) => buildLineShapes(fit, { kDark: bands.dark, kLight: bands.light }));
    const withLines = bodyLayers.map(({ fill, commands }, at) => ({ fill, commands: [...commands, ...orientSubpaths(lineShapes.flatMap((lineShape) => lineShape[['base', 'dark', 'light'][at]]), clockwise)] }));
    const withoutLines = bodyLayers;

    const fullWith = buildSvg({ width, height, layers: withLines });
    const fullWithout = buildSvg({ width, height, layers: withoutLines });
    const [maskWith, maskWithout] = await Promise.all([renderMask(fullWith, width), renderMask(fullWithout, width)]);
    const [boxWith, boxWithout] = [maskBox(maskWith, width, height), maskBox(maskWithout, width, height)];

    // How far the redrawn lines are from the picture, around each line.
    const deviations = fits.map((fit) => {
        const region = dilateMask(fit.piece, width, height, 4);
        const moved = displacement(maskWith, silhouette, region, width, height, MAX_MOVE + 3);
        let different = 0;
        let total = 0;
        region.forEach((value, at) => {
            total += fit.piece[at];
            different += value === 1 && maskWith[at] !== silhouette[at] ? 1 : 0;
        });
        return {
            moved,
            differentShare: different / total,
            dot: { moved: Math.hypot(fit.dot.cx - fit.measured.dot.cx, fit.dot.cy - fit.measured.dot.cy), radiusChange: fit.dot.r - fit.measured.dot.r, rms: fit.measured.dot.rms },
            widths: fit.measured.widths,
            lineMedian: fit.measured.lineMedian,
        };
    });
    const tooFar = deviations.findIndex(({ moved }) => moved > MAX_MOVE);
    if (tooFar >= 0) {
        throw new Error(`Line ${tooFar + 1} is ${deviations[tooFar].moved} pixels from the picture after the redraw, more than ${MAX_MOVE}; nothing was written.`);
    }

    const frame = frameEmblem(boxWith, base.centreX, 'base');
    const cleanWith = buildSvg({ width: frame.side, height: frame.side, layers: withLines, offsetX: frame.offsetX, offsetY: frame.offsetY });
    const cleanWithout = buildSvg({ width: frame.side, height: frame.side, layers: withoutLines, offsetX: frame.offsetX, offsetY: frame.offsetY });

    const colours = plateColours(baseHex);
    const placements = {};
    const plates = [];
    const files = [{ path: join(absoluteOut, 'logo-emblem.svg'), bytes: Buffer.from(cleanWith) }, { path: join(absoluteOut, 'logo-emblem-nolines.svg'), bytes: Buffer.from(cleanWithout) }];
    const edgeWith = boundaryCorners(maskWith, width);
    const edgeWithout = boundaryCorners(maskWithout, width);
    for (const plateShape of shapes) {
        const { id, shape } = plateShape;
        const placeWith = placeEmblem({ shape, box: boxWith, domeX: base.centreX, edge: edgeWith });
        const placeWithout = placeEmblem({ shape, box: boxWithout, domeX: base.centreX, edge: edgeWithout });
        placements[id] = { withLines: placeWith, withoutLines: placeWithout };
        for (const style of styles) {
            const svgs = {
                withLines: plateSvg({ shape, colours: colours[style.id], layers: withLines, placement: placeWith }),
                withoutLines: plateSvg({ shape, colours: colours[style.id], layers: withoutLines, placement: placeWithout }),
            };
            files.push({ path: join(absoluteOut, plateName(plateShape, style, true)), bytes: Buffer.from(svgs.withLines) }, { path: join(absoluteOut, plateName(plateShape, style, false)), bytes: Buffer.from(svgs.withoutLines) });
            plates.push({ id: `${id}-${style.id}`, label: `${id}-${style.id}`, ...svgs });
        }
    }
    const order = ['S-L', 'S-D', 'C-L', 'C-D'];
    plates.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    // A file that fails its checks stops the run before anything is written or logged.
    const checks = files.map(({ path, bytes }) => checkFinalSvg(bytes.toString(), toLogPath(rootDir, path), maxBytes));

    let sheet;
    if (absoluteSheet) {
        const scaleText = (id) => `${placements[id].withoutLines.scale.toFixed(4)} without lines, ${placements[id].withLines.scale.toFixed(4)} with`;
        const notes = [
            `plate L ${colours.L.plate}, lip ${colours.L.lip}   plate D ${colours.D.plate}, lip ${colours.D.lip}`,
            ...shapes.map(({ id, shape }) => `${id}: ${shape === 'square' ? `superellipse n=${SQUIRCLE_EXPONENT}` : 'circle'}, emblem at ${scaleText(id)} (plate units per source pixel)`),
            `lines: width ${lineWidth} px, dots r ${fits[0].dot.r.toFixed(1)} px, bands dark ${bands.dark} and light ${bands.light} px`,
        ];
        sheet = await buildPlateSheet({ reference: cleanWith, plates, notes });
    }

    mkdirSync(absoluteOut, { recursive: true });
    for (const { path, bytes } of files) {
        writeFileSync(path, bytes, { flag: 'wx' });
    }
    if (absoluteSheet) {
        mkdirSync(dirname(absoluteSheet), { recursive: true });
        writeFileSync(absoluteSheet, sheet);
    }
    const outputs = files.map(({ path, bytes }) => ({ file: toLogPath(rootDir, path), sha256: sha256(bytes) }));
    if (!preview) {
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage: 's4',
            provider: 'local',
            model: 'vectorize',
            template: 'logo-plates',
            vars: {
                source: toLogPath(rootDir, resolve(inPath)),
                tones: tones.map((tone) => tone.hex),
                base: baseHex.toLowerCase(),
                centring: 'base',
                shading: 'b',
                shapes: shapes.map(({ name }) => name),
                squircleExponent: SQUIRCLE_EXPONENT,
                colours: Object.fromEntries(styles.map(({ id, name }) => [name, colours[id]])),
                kDark: bands.dark,
                kLight: bands.light,
                lineWidth,
                dotRadius: Math.round(fits[0].dot.r * 100) / 100,
            },
            refHashes: [sha256(sourceBytes)],
            size: `${frame.side}x${frame.side}`,
            outputs,
            estimatedUsd: 0,
        }));
    }
    return {
        found,
        tones,
        base,
        box: boxWith,
        boxWithout,
        frame,
        thickness,
        lineWidth,
        bands,
        dotRadius: fits[0].dot.r,
        fits: fits.map((fit, at) => ({ towards: fit.towards, vertices: fit.vertices, dot: fit.dot, edge: fit.edge, measured: fit.measured, deviation: deviations[at] })),
        bodyCheck,
        colours,
        placements,
        files: files.map(({ path }, at) => ({ file: toLogPath(rootDir, path), bytes: checks[at].bytes, gzipBytes: checks[at].gzipBytes })),
        sheet: absoluteSheet ? toLogPath(rootDir, absoluteSheet) : undefined,
        outputs,
    };
}
