import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadArt } from './github-art.mjs';
import { parseHex } from './github-colour.mjs';
import { measureLineup } from './github-lineup.mjs';
import { ensureMargin, padClippedRim } from './github-master.mjs';
import { SNAPPED_DIR } from './github-paths.mjs';
import { eraseWithRings } from './github-repair.mjs';
import { encodePng, opaqueBox, readRaster } from './raster.mjs';
import { prepareSnap, snapVars } from './snap-run.mjs';
import { measureRings } from './pixel-snap.mjs';

const SCENE_KEYS = new Set(['master', 'patch', 'cell', 'bodyHeight', 'figureHeight', 'reisen', 'pose', 'repairs', 'note']);
const REPAIR_KEYS = new Set(['erase', 'cell', 'note']);
const SIZING_KEYS = ['cell', 'bodyHeight', 'figureHeight'];
const POSES = ['standing', 'seated', 'mixed'];

/** @param {string} rootDir */
export function loadScenes(rootDir) {
    const path = join(rootDir, 'github-scenes.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const scenes = {};
    for (const [name, scene] of Object.entries(raw.scenes ?? {})) {
        const where = `github-scenes.json scene "${name}"`;
        for (const key of Object.keys(scene)) {
            if (!SCENE_KEYS.has(key)) {
                throw new Error(`${where} has an unknown key "${key}". Known keys: ${[...SCENE_KEYS].join(', ')}.`);
            }
        }
        if (typeof scene.master !== 'string') {
            throw new Error(`${where} needs "master", the picture to snap.`);
        }
        if ('patch' in scene && typeof scene.patch !== 'string') {
            throw new Error(`${where}: "patch" is the path of the picture that was patched into the master, such as the output of patch.mjs.`);
        }
        if (SIZING_KEYS.filter((key) => key in scene).length !== 1) {
            throw new Error(`${where} needs exactly one of "cell", "bodyHeight" (Reisen's 340 px line-up height) and "figureHeight" (the height in art pixels that the whole sticker is to have).`);
        }
        if (!['left', 'right'].includes(scene.reisen) || !POSES.includes(scene.pose)) {
            throw new Error(`${where} needs "reisen" (left or right) and "pose" (${POSES.join(', ')}).`);
        }
        const repairs = (scene.repairs ?? []).map((repair, index) => {
            for (const key of Object.keys(repair)) {
                if (!REPAIR_KEYS.has(key)) {
                    throw new Error(`${where} repair ${index} has an unknown key "${key}".`);
                }
            }
            return repair;
        });
        scenes[name] = { ...scene, repairs };
    }
    return scenes;
}

/** A box carried to another cell: its edges are scaled and rounded outwards, so a box never shrinks past what it covered. */
function scaledBox({ x, y, width, height }, factor) {
    const left = Math.floor(x * factor);
    const top = Math.floor(y * factor);
    return { x: left, y: top, width: Math.ceil((x + width) * factor) - left, height: Math.ceil((y + height) * factor) - top };
}

/**
 * Snaps one scene the way snap.mjs snaps a preview, and logs nothing: the master is padded where only the sticker's rings are cut
 * by the canvas edge, snapped at the scene's cell (or at Reisen's line-up body height), and the configured repairs are made on the
 * snapped picture. The file goes to out/github/snapped/<name>.png. `vars` is what a logged run records (see `loggedScenes`): what
 * pixel-snap records of the snap itself, which is made before the repairs, and, under `github`, what is done to the master before it and
 * to the snapped picture after it.
 * @param {{ rootDir: string, name: string, scene: ReturnType<typeof loadScenes>[string] }} request
 */
export async function snapScene({ rootDir, name, scene }) {
    const masterPath = join(rootDir, scene.master);
    const master = await readRaster(masterPath);
    const { raster: clipFixed, padded: padding } = padClippedRim(master);
    const { raster: padded, added } = ensureMargin(clipFixed);
    const isChanged = padded !== master;
    const masterBytes = isChanged ? await encodePng(padded) : readFileSync(masterPath);
    const options = Object.fromEntries(SIZING_KEYS.filter((key) => key in scene).map((key) => [key, scene[key]]));
    const prepared = await prepareSnap({ rootDir, masterPath, masterBytes, id: name, options, preview: true, replace: true, outPath: join(SNAPPED_DIR, `${name}.png`) });
    const rings = { rimWidth: prepared.report.rings.rimWidth, bandWidth: prepared.report.rings.bandWidth, rim: parseHex(prepared.report.rings.rim), band: parseHex(prepared.report.rings.band) };
    const colours = { rim: [rings.rim.r, rings.rim.g, rings.rim.b], band: [rings.band.r, rings.band.g, rings.band.b] };
    let raster = prepared.raster;
    const before = prepared.raster;
    const repaired = [];
    if (scene.repairs.length > 0) {
        // A repair box is measured at the cell it names (or at the cell the scene is snapped at), and is carried to the cell of this snap.
        const boxes = scene.repairs.map(({ erase, cell: measuredAt = prepared.report.cell }) => scaledBox(erase, measuredAt / prepared.report.cell));
        const done = eraseWithRings(raster, boxes, { ...rings, rim: colours.rim, band: colours.band });
        raster = done.raster;
        repaired.push({ boxes, erased: done.erased, grown: done.grown });
    }
    const file = join(rootDir, SNAPPED_DIR, `${name}.png`);
    const png = await encodePng(raster);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);

    const box = opaqueBox(raster);
    const measured = measureRings(raster, colours);
    let problem;
    try {
        await loadArt(file);
    } catch (error) {
        problem = error.message;
    }
    return {
        name,
        file: join(SNAPPED_DIR, `${name}.png`),
        cell: prepared.report.cell,
        cellSource: prepared.report.cellSource,
        offset: prepared.report.offset,
        size: { width: raster.width, height: raster.height },
        drawn: { width: box.width, height: box.height },
        margins: { left: box.x, top: box.y, right: raster.width - box.x - box.width, bottom: raster.height - box.y - box.height },
        rings: { asked: { rim: rings.rimWidth, band: rings.bandWidth }, measured: { rim: measured.rimWidth, band: measured.bandWidth } },
        padded: padding,
        marginAdded: added,
        repaired,
        lineup: measureLineup(raster, scene),
        problem,
        raster,
        before,
        masterBox: prepared.report.master.figure,
        png,
        vars: {
            ...snapVars({ rootDir, masterPath, id: name, character: prepared.character, report: prepared.report }),
            github: { tool: 'github-snap.mjs', sizing: options, patch: scene.patch ?? null, masterPadded: padding, marginAdded: added, repairs: scene.repairs, repaired },
        },
    };
}

/**
 * Snapped scenes as the pictures of a logged run. Each is called by its scene name, which is the name of its approved copy
 * (approved/pixel/<name>.png) and of the art source that the config reads.
 * @param {ReturnType<typeof loadScenes>} scenes
 * @param {Array<Awaited<ReturnType<typeof snapScene>>>} results
 * @returns {import('./github-snap-log.mjs').LoggedSnap[]}
 */
export const loggedScenes = (scenes, results) => results.map(({ name, png, size, vars }) => ({ id: name, png, size, vars, master: scenes[name].master, patch: scenes[name].patch }));
