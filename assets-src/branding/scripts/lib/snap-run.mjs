import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { findOrphans } from './pixelate.mjs';
import { applyPixelPatch, parsePixelPatch } from './pixel-patch.mjs';
import { chooseGrid, countColours, measureRings, orphanToleranceFor, snapRaster } from './pixel-snap.mjs';
import { opaqueBox, readRaster } from './raster.mjs';
import { parseHexColour } from './rim-recolour.mjs';
import { figureProblems, measureFigureScaled } from './scene-measure.mjs';
import { resolveOutDir } from './run.mjs';
import { bodyHeightFor, characterOf, configuredRingWidths } from './snap-config.mjs';
import { assertFrameId, baseFixesFile, checkFrame, findBaseSnap, gridOptionsOf } from './snap-frame.mjs';
import { buildSamplingSheet, buildSnapSheet, parseRegions } from './snap-sheet.mjs';

const ID = /^[\w-]+$/;
const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');
const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
// The snapped picture's head to feet may differ this much (a share of the height asked for) from the master's before it is flagged.
const REMEASURE_TOLERANCE = 0.02;

/** The id a picture is snapped and approved under: its file name without the extension, or what the caller says. */
export function snapId(masterPath, id) {
    const chosen = id ?? basename(masterPath, extname(masterPath));
    if (!ID.test(chosen)) {
        throw new Error(`The id "${chosen}" may hold letters, digits, "_" and "-" only; pass --id to name it.`);
    }
    return chosen;
}

/**
 * The touch-ups of a picture: fixes/<id>.json when it exists, or the file the caller names (which must exist).
 * @returns {{ path: string, bytes: Buffer } | undefined}
 */
function findFixes({ rootDir, id, fixesPath }) {
    const path = fixesPath ? resolve(rootDir, fixesPath) : join(rootDir, 'fixes', `${id}.json`);
    if (!existsSync(path)) {
        if (fixesPath) {
            throw new Error(`The fixes file ${fixesPath} does not exist.`);
        }
        return undefined;
    }
    return { path, bytes: readFileSync(path) };
}

/**
 * The options a snap is made with. When the caller gave no cell, figure height or body height (and did not ask for `detect`), the body height is
 * the one snap-config.json sets for the picture's character: the character named, or the one the picture has in prompts/s5-masters.json.
 */
function resolveSizing({ rootDir, id, character, options, detect }) {
    if (detect || [options.cell, options.figureHeight, options.bodyHeight].some((given) => given !== undefined)) {
        return { options, character: character ?? null };
    }
    const set = bodyHeightFor({ rootDir, id, character });
    return { options: { ...options, bodyHeight: set.bodyHeight }, character: set.character };
}

/**
 * Snaps one master and applies its touch-ups. The touch-ups come after the snap and are a fixed list of pixels, so snapping the same master
 * with the same options always gives the same file. With `noFixes` the fixes/<id>.json that would be found is not looked for, which is how a
 * frame gets the touch-ups of its base (named by `fixesPath`) and no others.
 * With `masterBytes` the master is those bytes (a picture that is made in memory and not written yet) and `masterPath` only names it.
 * @param {{ rootDir: string, masterPath: string, masterBytes?: Buffer, id?: string, options?: Parameters<typeof snapRaster>[1], fixesPath?: string, noFixes?: boolean, character?: string, detect?: boolean }} request
 */
export async function snapPicture({ rootDir, masterPath, masterBytes: given, id, options = {}, fixesPath, noFixes = false, character, detect = false }) {
    const name = snapId(masterPath, id);
    const sized = resolveSizing({ rootDir, id: name, character, options, detect });
    const masterBytes = given ?? readFileSync(masterPath);
    sniffImage(masterBytes);
    const master = await readRaster(masterBytes);
    // The ring widths are one for every picture: the config sets them, and a flag or batch key for this picture overrides them.
    const { raster: snapped, report } = snapRaster(master, { ...configuredRingWidths(rootDir), ...Object.fromEntries(Object.entries(sized.options).filter(([, value]) => value !== undefined)) });
    const fixes = noFixes ? undefined : findFixes({ rootDir, id: name, fixesPath });
    let raster = snapped;
    let patched = null;
    if (fixes) {
        const ops = parsePixelPatch(JSON.parse(fixes.bytes.toString('utf8')), snapped);
        const applied = applyPixelPatch(snapped, ops);
        raster = applied.raster;
        patched = { file: toLogPath(rootDir, fixes.path), sha256: sha256(fixes.bytes), edits: ops.length, changed: applied.changed };
    }
    const orphans = findOrphans(raster, { tolerance: orphanToleranceFor(options.colours) });
    const figure = opaqueBox(raster);
    const body = measureFigureScaled(raster);
    const problems = figureProblems(master, measureFigureScaled(master));
    const asked = report.targetBodyHeight;
    if (asked !== null && Math.abs(body.figureHeight - asked) / asked > REMEASURE_TOLERANCE) {
        problems.push(`measured again on the snapped picture, head to feet is ${body.figureHeight} art px, not the ${asked} asked for: the head top is found ${asked < body.figureHeight ? 'higher' : 'lower'} at the smaller size, so a scene that sizes this still by its figure would scale it ${Math.abs(Math.round((body.figureHeight / asked - 1) * 100))}% off`);
    }
    const rings = report.rings ? { ...report.rings, measured: measureRings(raster, { rim: parseHexColour(report.rings.rim), band: parseHexColour(report.rings.band) }) } : null;
    if (rings && (rings.measured.rimWidth !== rings.rimWidth || rings.measured.bandWidth !== rings.bandWidth)) {
        const { rimWidth, bandWidth } = rings.measured;
        problems.push(`the rings measure rim ${rimWidth} + band ${bandWidth} art px, not the rim ${rings.rimWidth} + band ${rings.bandWidth} asked for`);
    }
    return {
        id: name,
        character: sized.character,
        master,
        masterBytes,
        raster,
        report: {
            ...report,
            rings,
            size: { width: raster.width, height: raster.height },
            figure,
            figureHeight: figure?.height,
            body: { headTop: body.headTop, feet: body.feet, height: body.figureHeight, method: body.method, problems },
            distinctColours: countColours(raster),
            orphans,
            fixes: patched,
        },
    };
}

/** The review regions of a picture from review/<id>.json, or none when the file does not exist. */
export function readRegions({ rootDir, id, master }) {
    const path = join(rootDir, 'review', `${id}.json`);
    return existsSync(path) ? parseRegions(JSON.parse(readFileSync(path, 'utf8')), master) : { faces: [], hands: [] };
}

const absoluteIn = (rootDir, path) => (isAbsolute(path) ? path : resolve(rootDir, path));

/**
 * Everything a snap needs before anything is written: the checks on where it goes, the snapped picture, its PNG and its review sheet,
 * all in memory. A batch prepares every picture first, so a bad one stops the batch before the first file or log line is written.
 * With `gridFrom` (an approved snap's file or sha256) the picture is a frame of that snap: it takes the snap's grid and settings as logged,
 * with nothing detected, is called `<snap id>--<name>`, and is checked against the snap, which `frameRegion` (master pixels) limits to the area
 * that may change. The check is made before anything is written.
 * A frame can also be given the base snap itself, as `baseSnap` (what `findBaseSnap` returns), for a base that is snapped in the same run and not logged yet.
 * With `replace` a picture that already exists at the output path is not an error, for previews that are made again.
 * @param {{ rootDir: string, masterPath: string, masterBytes?: Buffer, id?: string, options?: Parameters<typeof snapRaster>[1], fixesPath?: string, character?: string, detect?: boolean,
 *   outPath?: string, outDir?: string, stage?: string, preview?: boolean, replace?: boolean, sheetPath?: string, gridFrom?: string, baseSnap?: Awaited<ReturnType<typeof findBaseSnap>>, frameRegion?: { x: number, y: number, width: number, height: number } }} request
 */
export async function prepareSnap({ rootDir, masterPath, masterBytes, id, options = {}, fixesPath, character, detect, outPath, outDir, stage, preview = false, replace = false, sheetPath, gridFrom, baseSnap, frameRegion }) {
    const name = snapId(masterPath, id);
    if (!preview && !stage) {
        throw new Error('Pass --stage (such as s5) for a run that is logged, or --preview to write under out/ without logging.');
    }
    const target = outPath ?? (preview ? join('out', 'snap', `${name}-preview.png`) : join(outDir ?? join('raw', stage, 'pixel'), `${name}.png`));
    const absoluteOut = absoluteIn(rootDir, target);
    resolveOutDir(rootDir, dirname(absoluteOut));
    const logOut = toLogPath(rootDir, absoluteOut);
    if (preview && !logOut.startsWith('out/')) {
        throw new Error(`A preview is written under out/ only, not ${logOut}, so it cannot be mistaken for a snap.`);
    }
    if (!replace && existsSync(absoluteOut)) {
        throw new Error(`${logOut} already exists; pick another name or remove it first.`);
    }
    const absoluteSheet = sheetPath ? absoluteIn(rootDir, sheetPath) : undefined;
    if (absoluteSheet) {
        resolveOutDir(rootDir, dirname(absoluteSheet));
    }

    const base = baseSnap ?? (gridFrom ? await findBaseSnap({ rootDir, from: gridFrom }) : undefined);
    if (!base && frameRegion) {
        throw new Error('--frame-region limits what a frame changed from its base, so it needs --grid-from.');
    }
    if (base) {
        assertFrameId(name, base.id);
        if (existsSync(join(rootDir, 'fixes', `${name}.json`))) {
            throw new Error(`fixes/${name}.json exists, but a frame gets the touch-ups of its base snap "${base.id}" and no others. Remove the file.`);
        }
    }
    const snap = base
        ? await snapPicture({ rootDir, masterPath, masterBytes, id: name, options: gridOptionsOf(base), fixesPath: baseFixesFile(rootDir, base), noFixes: !base.vars.fixes, character: base.vars.character ?? undefined })
        : await snapPicture({ rootDir, masterPath, masterBytes, id: name, options, fixesPath, character, detect });
    const frame = base ? checkFrame({ base: base.raster, frame: snap.raster, grid: { cell: snap.report.cell, offset: snap.report.offset }, baseId: base.id, region: frameRegion, masterSize: snap.master }) : undefined;
    const report = frame ? { ...snap.report, frame: { ...frame, base: { id: base.id, sha256: base.sha256, file: base.file } } } : snap.report;
    const png = await sharp(snap.raster.data, { raw: { width: snap.raster.width, height: snap.raster.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    let sheet;
    if (absoluteSheet) {
        const grid = { cell: report.cell, offsetX: report.offset.x, offsetY: report.offset.y };
        const caption = `${name}, cell ${report.cell.toFixed(3)}, ${report.size.width}x${report.size.height} art px, figure ${report.figureHeight} tall, head to feet ${report.body.height}`;
        sheet = { path: absoluteSheet, bytes: await buildSnapSheet({ master: snap.master, native: snap.raster, grid, regions: readRegions({ rootDir, id: name, master: snap.master }), caption }) };
    }
    const refHashes = base ? [sha256(snap.masterBytes), base.sha256] : [sha256(snap.masterBytes)];
    return { ...snap, report, masterPath, absoluteOut, logOut, png, sheet, refHashes, base: base ? { id: base.id, sha256: base.sha256, file: base.file } : undefined };
}

/**
 * Writes a prepared snap: the PNG (never over a file), the sheet, and, unless it is a preview, one log entry as a local tool (no model call,
 * so no cost): `refs` holds the master's sha256 (and, for a frame, the base snap's), and everything needed to repeat the snap is in `vars`.
 */
export function commitSnap(prepared, { rootDir, stage, preview = false, now }) {
    const { report } = prepared;
    mkdirSync(dirname(prepared.absoluteOut), { recursive: true });
    writeFileSync(prepared.absoluteOut, prepared.png, { flag: 'wx' });
    let sheet;
    if (prepared.sheet) {
        mkdirSync(dirname(prepared.sheet.path), { recursive: true });
        writeFileSync(prepared.sheet.path, prepared.sheet.bytes);
        sheet = toLogPath(rootDir, prepared.sheet.path);
    }
    if (!preview) {
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage,
            provider: 'local',
            model: 'pixel-snap',
            template: 'pixel-snap',
            vars: snapVars({ rootDir, masterPath: prepared.masterPath, id: prepared.id, character: prepared.character, report }),
            refHashes: prepared.refHashes,
            size: `${report.size.width}x${report.size.height}`,
            outputs: [{ file: prepared.logOut, sha256: sha256(prepared.png) }],
            estimatedUsd: 0,
        }));
    }
    return { file: prepared.logOut, sheet, id: prepared.id, character: prepared.character, raster: prepared.raster, master: prepared.master, report };
}

/**
 * Snaps a master and writes the result. A real run writes under raw/<stage>/pixel/ (or --out) and logs one entry; a `preview`
 * writes under out/ only and logs nothing. The master and approved/ are never written.
 * @param {Parameters<typeof prepareSnap>[0] & { now: () => Date }} request
 */
export async function runSnap({ now, ...request }) {
    const prepared = await prepareSnap(request);
    return commitSnap(prepared, { rootDir: request.rootDir, stage: request.stage, preview: request.preview, now });
}

const BATCH_KEYS = new Set(['outDir', 'items']);
const ITEM_KEYS = new Set(['in', 'id', 'character', 'bodyHeight', 'figureHeight', 'cell', 'ringRepair', 'rimWidth', 'bandWidth']);

/**
 * Parses a batch file: `{ outDir, items: [{ in, id, character, bodyHeight | figureHeight | cell, ringRepair }] }`. Every item is one snap; ids
 * (the file name unless given) must be different, because they name the output and the approved copy.
 * @param {any} raw
 */
export function parseBatch(raw) {
    for (const key of Object.keys(raw ?? {})) {
        if (!BATCH_KEYS.has(key)) {
            throw new Error(`Batch file: unknown key "${key}". Known keys: ${[...BATCH_KEYS].join(', ')}.`);
        }
    }
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
        throw new Error('Batch file: items needs at least one picture.');
    }
    const items = raw.items.map((item, index) => {
        const where = `Batch item ${index + 1}${typeof item?.in === 'string' ? ` (${item.in})` : ''}`;
        for (const key of Object.keys(item ?? {})) {
            if (!ITEM_KEYS.has(key)) {
                throw new Error(`${where}: unknown key "${key}". Known keys: ${[...ITEM_KEYS].join(', ')}.`);
            }
        }
        if (typeof item.in !== 'string' || item.in === '') {
            throw new Error(`${where} needs "in", the picture to snap.`);
        }
        const id = snapId(item.in, item.id);
        return { in: item.in, id, character: item.character, options: { bodyHeight: item.bodyHeight, figureHeight: item.figureHeight, cell: item.cell, rimWidth: item.rimWidth, bandWidth: item.bandWidth, ...(item.ringRepair === undefined ? {} : { ringRepair: item.ringRepair }) } };
    });
    const seen = new Set();
    for (const { id } of items) {
        if (seen.has(id)) {
            throw new Error(`Batch file: two pictures are called "${id}"; give one an "id".`);
        }
        seen.add(id);
    }
    return { outDir: raw.outDir, items };
}

/**
 * Snaps every picture of a batch, one after the other in this process, so only one writer ever appends to the log. Every picture is snapped,
 * checked and sheeted first; the first file is written only when all of them came out. With `dryRun` nothing is written or logged.
 * @param {{ rootDir: string, batch: ReturnType<typeof parseBatch>, stage?: string, outDir?: string, sheetDir?: string, dryRun?: boolean, sample?: string, now: () => Date }} request
 */
export async function runBatch({ rootDir, batch, stage, outDir, sheetDir, dryRun = false, sample, now }) {
    if (!dryRun && !stage) {
        throw new Error('Pass --stage (such as s5) for a batch that is logged, or --dry-run.');
    }
    const prepared = [];
    for (const item of batch.items) {
        try {
            prepared.push(await prepareSnap({
                rootDir,
                masterPath: absoluteIn(rootDir, item.in),
                id: item.id,
                character: item.character,
                options: { ...item.options, ...(sample ? { sample } : {}) },
                outDir: outDir ?? batch.outDir,
                stage: stage ?? 'dry-run',
                sheetPath: sheetDir ? join(sheetDir, `${item.id}-sheet.png`) : undefined,
            }));
        } catch (error) {
            throw new Error(`${item.id}: ${error.message} Nothing was written.`);
        }
    }
    if (dryRun) {
        return prepared.map((one) => ({ file: one.logOut, id: one.id, character: one.character, report: one.report }));
    }
    return prepared.map((one) => commitSnap(one, { rootDir, stage, now }));
}

/** What the log records of a snap: the options that made it, exactly as `snap.mjs` takes them back, and how it came out. */
export function snapVars({ rootDir, masterPath, id, character, report }) {
    return {
        id,
        master: toLogPath(rootDir, resolve(masterPath)),
        character,
        cell: report.cell,
        cellSource: report.cellSource,
        offset: report.offset,
        pitch: report.pitchAcross === null ? null : { across: round(report.pitchAcross), down: round(report.pitchDown), strengthAcross: round(report.strengthAcross), strengthDown: round(report.strengthDown) },
        sample: report.sample,
        colours: report.colours,
        targetBodyHeight: report.targetBodyHeight,
        targetFigureHeight: report.targetFigureHeight,
        bodyArtPixels: report.body.height,
        figureArtPixels: report.figureHeight,
        ringRepair: report.rings !== null,
        rings: report.rings ? { rimWidth: report.rings.rimWidth, bandWidth: report.rings.bandWidth, rim: report.rings.rim, band: report.rings.band } : null,
        ringsMeasured: report.rings ? { rimWidth: report.rings.measured.rimWidth, bandWidth: report.rings.measured.bandWidth } : null,
        orphans: report.orphans.length,
        fixes: report.fixes,
        ...(report.frame ? { gridFrom: report.frame.base, frame: { changed: report.frame.changed, box: report.frame.box, masterBox: report.frame.masterBox, region: report.frame.region } } : {}),
    };
}

/**
 * The pitch of every approved master, and where its head top and feet are. For a picture of one character with a body height set, it also gives
 * the cell that height asks for and the figure's height in art pixels at that cell. A design sheet (its name starts with the timestamp of its
 * generation) and a picture with no figure are listed as skipped, with the reason. A picture is `flags`-marked for what `figureProblems` finds:
 * a head top not found, a head top made of skin (a raised arm), or feet that reach the canvas edge.
 * @param {{ rootDir: string, approvedDir: string, figureHeight?: number, only?: string[] }} request
 */
export async function measureMasters({ rootDir, approvedDir, figureHeight, only }) {
    if (!existsSync(approvedDir)) {
        throw new Error(`${approvedDir} does not exist, so there is nothing to measure.`);
    }
    const files = readdirSync(approvedDir).filter((file) => file.endsWith('.png')).sort();
    const rows = [];
    const skipped = [];
    for (const file of files) {
        const id = basename(file, '.png');
        if (only && !only.includes(id)) {
            continue;
        }
        if (/^\d/.test(file)) {
            skipped.push({ file, reason: 'a design sheet, not a master' });
            continue;
        }
        try {
            const master = await readRaster(join(approvedDir, file));
            const detected = chooseGrid(master);
            const row = {
                id,
                character: lookupCharacter(rootDir, id),
                figure: detected.box,
                body: { headTop: detected.body.headTop, feet: detected.body.feet, height: detected.body.figureHeight, method: detected.body.method, ratio: detected.body.figureHeight / detected.box.height },
                pitchAcross: detected.pitchAcross,
                pitchDown: detected.pitchDown,
                strengthAcross: detected.strengthAcross,
                strengthDown: detected.strengthDown,
                cell: detected.cell,
                bodyAtDetected: detected.body.figureHeight / detected.cell,
                fitAtDetected: { across: detected.fitAcross, down: detected.fitDown },
                problems: figureProblems(master, detected.body),
                flags: [],
                master,
            };
            row.set = bodySet(rootDir, id, row);
            if (figureHeight !== undefined) {
                const targeted = chooseGrid(master, { figureHeight });
                row.target = { figureHeight, cell: targeted.cell, cellVersusDetected: targeted.cell / detected.cell - 1, fit: { across: targeted.fitAcross, down: targeted.fitDown } };
            }
            rows.push(row);
        } catch (error) {
            skipped.push({ file, reason: error.message });
        }
    }
    flagProblems(rows);
    return { rows, skipped };
}

function lookupCharacter(rootDir, id) {
    try {
        return characterOf(rootDir, id);
    } catch {
        return null;
    }
}

/** The body height set for the picture and what it means for this picture: the cell, and the figure's heights in art pixels at that cell. */
function bodySet(rootDir, id, row) {
    if (!row.character || row.body.method !== 'head') {
        return null;
    }
    let set;
    try {
        set = bodyHeightFor({ rootDir, id });
    } catch {
        return null;
    }
    const cell = row.body.height / set.bodyHeight;
    return { bodyHeight: set.bodyHeight, cell, boxArtHeight: row.figure.height / cell };
}

function flagProblems(rows) {
    for (const row of rows) {
        row.flags.push(...row.problems);
    }
}

/** The area to compare ways of sampling on: both sides of the first face in review/<id>.json, else the top quarter of the figure. */
function comparisonBox(regions, figure) {
    const face = regions.faces[0];
    if (!face) {
        return { x: figure.x, y: figure.y, width: figure.width, height: Math.round(figure.height / 4) };
    }
    const x = Math.min(face.left.x, face.right.x);
    const y = Math.min(face.left.y, face.right.y);
    return {
        x,
        y,
        width: Math.max(face.left.x + face.left.width, face.right.x + face.right.width) - x,
        height: Math.max(face.left.y + face.left.height, face.right.y + face.right.height) - y,
    };
}

/**
 * Snaps one master four ways on the same grid (median or mode of the middle of each cell, with and without `colours` palette colours) and
 * measures each. Nothing is written or logged unless `sheetPath` is given, and then only the comparison picture.
 * @param {{ rootDir: string, masterPath: string, id?: string, options?: Parameters<typeof snapRaster>[1], colours: number, sheetPath?: string }} request
 */
export async function compareSampling({ rootDir, masterPath, id, options = {}, character, detect, colours, sheetPath }) {
    const name = snapId(masterPath, id);
    const first = await snapPicture({ rootDir, masterPath, id: name, options: { ...options, sample: 'median', colours: undefined }, character, detect });
    const pinned = { ...options, cell: first.report.cell, figureHeight: undefined, bodyHeight: undefined };
    const variants = [{ sample: 'median', colours: undefined, snap: first }];
    for (const [sample, count] of [['mode', undefined], ['median', colours], ['mode', colours]]) {
        variants.push({ sample, colours: count, snap: await snapPicture({ rootDir, masterPath, id: name, options: { ...pinned, sample, colours: count } }) });
    }
    const results = variants.map(({ sample, colours: count, snap }) => ({
        sample,
        colours: count ?? null,
        distinctColours: snap.report.distinctColours,
        orphansNear: snap.report.orphansNear,
        orphansExact: snap.report.orphansExact,
        reprojectionError: snap.report.reprojectionError,
        ringsBroken: snap.report.rings?.broken ?? null,
        label: `${sample}, ${count === undefined ? 'no palette' : `${count} colours`}\n${snap.report.orphansNear} orphans, ${snap.report.distinctColours} colours, error ${snap.report.reprojectionError.toFixed(2)}`,
    }));
    let sheet;
    if (sheetPath) {
        const absoluteSheet = isAbsolute(sheetPath) ? sheetPath : resolve(rootDir, sheetPath);
        resolveOutDir(rootDir, dirname(absoluteSheet));
        const { report } = first;
        const grid = { cell: report.cell, offsetX: report.offset.x, offsetY: report.offset.y };
        const box = comparisonBox(readRegions({ rootDir, id: name, master: first.master }), report.master.figure);
        mkdirSync(dirname(absoluteSheet), { recursive: true });
        writeFileSync(absoluteSheet, await buildSamplingSheet({ master: first.master, grid, box, variants: variants.map(({ snap }, at) => ({ label: results[at].label, native: snap.raster })) }));
        sheet = toLogPath(rootDir, absoluteSheet);
    }
    return { id: name, cell: first.report.cell, results, sheet };
}
