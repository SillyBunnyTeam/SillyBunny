import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkMaskedFrame } from './frame-check.mjs';
import { composeFrame, countOf } from './frame-mask.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { FRAME_MARGIN } from './snap-frame.mjs';
import { createRaster, encodePng, readRaster } from './raster.mjs';
import { resolveOutDir } from './run.mjs';
import { commitSnap, prepareSnap, snapVars } from './snap-run.mjs';
import { configuredRingWidths } from './snap-config.mjs';
import { renderSplashGallery } from './splash-gallery.mjs';
import { drawLayers, layOutPair, layerOf } from './splash-scene.mjs';
import { loadSplashConfig, SPLASH_CONFIG_FILE } from './splash-config.mjs';

export const PREVIEW_DIR = 'out/splash';
export const GALLERY_FILE = 'out/gallery/splash-anim.html';

const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');
const absoluteIn = (rootDir, path) => (isAbsolute(path) ? path : resolve(rootDir, path));
const frameIdOf = (baseId, name) => `${baseId}--${name}`;

function maskBox(mask, width) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let at = 0; at < mask.length; at++) {
        if (mask[at] === 1) {
            const x = at % width;
            const y = (at - x) / width;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
        }
    }
    return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** The frame with every pixel that comes from the base dimmed and tinted blue, so the cut can be seen on the picture itself. */
function cutPicture(frame, cut) {
    const picture = createRaster(frame.width, frame.height);
    for (let at = 0; at < cut.length; at++) {
        const from = at * 4;
        const keptFromBase = cut[at] === 0;
        picture.data[from] = Math.round(frame.data[from] * (keptFromBase ? 0.55 : 1));
        picture.data[from + 1] = Math.round(frame.data[from + 1] * (keptFromBase ? 0.55 : 1));
        picture.data[from + 2] = Math.min(255, Math.round(frame.data[from + 2] * (keptFromBase ? 0.55 : 1)) + (keptFromBase ? 90 : 0));
        picture.data[from + 3] = 255;
        if (frame.data[from + 3] === 0) {
            picture.data[from] = 122;
            picture.data[from + 1] = 122;
            picture.data[from + 2] = 136;
        }
    }
    return picture;
}

/** The snap of one base, prepared in memory: the object `--grid-from` would find in the log, so the frames can take its grid. */
async function prepareBase({ rootDir, key, base, locations, mode, stage }) {
    const prepared = await prepareSnap({
        rootDir,
        masterPath: absoluteIn(rootDir, base.file),
        id: base.id,
        character: base.character,
        options: base.options,
        outPath: join(locations.pixelDir, `${base.id}.png`),
        preview: mode !== 'build',
        replace: mode !== 'build',
        stage: stage ?? 'preview',
    });
    const snap = { id: base.id, vars: snapVars({ rootDir, masterPath: prepared.masterPath, id: prepared.id, character: prepared.character, report: prepared.report }), sha256: sha256(prepared.png), file: prepared.logOut, raster: prepared.raster };
    return { key, base, prepared, snap };
}

async function prepareFrame({ rootDir, item, built, locations, mode, stage, config }) {
    const { base, snap } = built[item.base];
    const baseMaster = built[item.base].prepared.master;
    const editPath = absoluteIn(rootDir, item.edit);
    const editBytes = readFileSync(editPath);
    const edit = await readRaster(editBytes);
    const composed = composeFrame({ base: baseMaster, edit, keep: item.keep, settings: item.settings });
    if (countOf(composed.moved) === 0) {
        throw new Error(`${frameIdOf(base.id, item.name)}: the edit differs from the base nowhere the mask keeps, so there is nothing to take from it. Check the edit and the settings.`);
    }
    const id = frameIdOf(base.id, item.name);
    const masterBytes = await encodePng(composed.raster);
    const masterPath = absoluteIn(rootDir, join(locations.masterDir, `${id}.png`));
    const prepared = await prepareSnap({
        rootDir,
        masterPath,
        masterBytes,
        id,
        baseSnap: snap,
        outPath: join(locations.pixelDir, `${id}.png`),
        preview: mode !== 'build',
        replace: mode !== 'build',
        stage: stage ?? 'preview',
    });
    const rings = configuredRingWidths(rootDir);
    const margin = FRAME_MARGIN + (rings.rimWidth ?? 2) + (rings.bandWidth ?? 2);
    let check;
    try {
        check = checkMaskedFrame({ base: snap.raster, frame: prepared.raster, cut: composed.cut, masterWidth: composed.raster.width, grid: { cell: prepared.report.cell, offset: prepared.report.offset }, keep: item.keep, margin });
    } catch (error) {
        throw new Error(`${id}: ${error.message}`);
    }
    const baseSha = sha256(built[item.base].prepared.masterBytes);
    return {
        id,
        name: item.name,
        base: item.base,
        item,
        composed,
        check,
        masterBytes,
        masterPath,
        prepared,
        maskBox: maskBox(composed.cut, composed.raster.width),
        maskPixels: countOf(composed.cut),
        cutBytes: await encodePng(cutPicture(composed.raster, composed.cut)),
        logVars: {
            id,
            base: { id: base.id, master: base.file, sha256: baseSha, snap: { file: snap.file, sha256: snap.sha256 } },
            edit: { file: item.edit, sha256: sha256(editBytes) },
            settings: composed.settings,
            keep: item.keep,
            mask: { cutPixels: countOf(composed.cut), movedPixels: countOf(composed.moved), box: maskBox(composed.cut, composed.raster.width), stickerGrownBy: composed.sticker.radius, stickerMatch: Math.round(composed.sticker.score * 1e4) / 1e4 },
            dropped: composed.dropped,
            held: composed.held,
            config: config.file,
        },
        refs: [baseSha, sha256(editBytes)],
        warnings: prepared.report.body.problems,
    };
}

function planScene({ config, built, frames }) {
    const poseRasters = (key) => new Map([[built[key].base.pose, built[key].snap.raster], ...frames.filter(({ base }) => base === key).map(({ name, prepared }) => [name, prepared.raster])]);
    const sides = Object.fromEntries([config.scene.left, config.scene.right].map((key) => [key, { id: key, ...layerOf(poseRasters(key)) }]));
    const laid = layOutPair({ left: sides[config.scene.left], right: sides[config.scene.right], gap: config.scene.gap, margin: config.scene.margin });
    return { ...laid, layers: laid.layers.map((layer) => ({ ...layer, base: built[layer.id].base.pose })) };
}

const sceneFileName = (sceneId, layerId, pose) => `${sceneId}--${layerId}--${pose}.png`;

function sceneManifest({ config, scene, snaps }) {
    return {
        scene: config.scene.id,
        grid: { width: scene.width, height: scene.height },
        margin: scene.margin,
        gap: scene.gap,
        layers: scene.layers.map((layer) => ({
            id: layer.id,
            z: layer.z,
            left: layer.left,
            top: layer.top,
            width: layer.width,
            height: layer.height,
            source: snaps[layer.id].file,
            base: layer.base,
            frames: Object.fromEntries([...layer.frames.keys()].map((pose) => [pose, sceneFileName(config.scene.id, layer.id, pose)])),
        })),
        timelines: config.timelines,
    };
}

const logEntryFor = ({ now, stage, model, vars, refs, size, outputs }) => makeLogEntry({ time: now().toISOString(), stage, provider: 'local', model, template: model, vars, refHashes: refs, size, outputs, estimatedUsd: 0 });

/**
 * Makes the splash animation's character frames. In order: each base is snapped on its own grid; each frame is composed from its base and its edit
 * through a mask (`composeFrame`) and snapped on its base's grid; the changes are checked against the mask, not a rectangle; and both characters are laid
 * out as layers of one grid scene. Everything is built and checked in memory before any file is written. `mode` is `dry-run` (writes nothing),
 * `preview` (writes out/splash/ and out/gallery/splash-anim.html, logs nothing) or `build` (writes raw/<stage>/splash-anim/ and logs each base snap,
 * each composition (`frame-compose`), each frame snap and the layers, all as local tools).
 * @param {{ rootDir: string, mode: 'dry-run' | 'preview' | 'build', stage?: string, now: () => Date }} request
 */
export async function runSplash({ rootDir, mode, stage, now }) {
    if (mode === 'build' && !stage) {
        throw new Error('Pass --stage (such as s5) for a run that is logged, or --dry-run or --preview.');
    }
    const config = loadSplashConfig(rootDir);
    const folder = mode === 'build' ? `raw/${stage}/splash-anim` : PREVIEW_DIR;
    const locations = { root: resolveOutDir(rootDir, folder), pixelDir: join(folder, 'pixel'), masterDir: join(folder, mode === 'build' ? 'frames' : 'masters'), sceneDir: join(folder, 'scene') };
    const configBytes = readFileSync(join(rootDir, SPLASH_CONFIG_FILE));
    const configInfo = { file: SPLASH_CONFIG_FILE, sha256: sha256(configBytes) };

    const built = {};
    for (const [key, base] of Object.entries(config.bases)) {
        built[key] = await prepareBase({ rootDir, key, base, locations, mode, stage });
    }
    const frames = [];
    for (const item of config.frames) {
        frames.push(await prepareFrame({ rootDir, item, built, locations, mode, stage, config: configInfo }));
    }
    const scene = planScene({ config, built, frames });
    const snaps = Object.fromEntries(Object.entries(built).map(([key, one]) => [key, { file: one.snap.file }]));
    const manifest = sceneManifest({ config, scene, snaps });
    const neutral = drawLayers({ width: scene.width, height: scene.height, layers: scene.layers, poseOf: (id) => built[id].base.pose });
    const result = { config, built, frames, scene, manifest, warnings: [...Object.values(built).flatMap(({ prepared }) => prepared.report.body.problems.map((problem) => `${prepared.id}: ${problem}`)), ...frames.flatMap(({ id, warnings }) => warnings.map((problem) => `${id}: ${problem}`))], written: [], logged: 0 };
    if (mode === 'dry-run') {
        return result;
    }

    const sceneFiles = [];
    for (const layer of scene.layers) {
        for (const [pose, raster] of layer.frames) {
            sceneFiles.push({ file: sceneFileName(config.scene.id, layer.id, pose), bytes: await encodePng(raster), layer: layer.id });
        }
    }
    const neutralBytes = await encodePng(neutral);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 4)}\n`);
    const sceneOut = [...sceneFiles, { file: `${config.scene.id}.png`, bytes: neutralBytes }, { file: `${config.scene.id}--anim.json`, bytes: manifestBytes }];
    const targets = [
        ...Object.values(built).map(({ prepared }) => prepared.absoluteOut),
        ...frames.flatMap(({ prepared, masterPath }) => [prepared.absoluteOut, absoluteIn(rootDir, masterPath)]),
        ...sceneOut.map(({ file }) => join(rootDir, locations.sceneDir, file)),
    ];
    const existing = mode === 'build' ? targets.filter((path) => existsSync(path)) : [];
    if (existing.length > 0) {
        throw new Error(`${existing.length} of the files already exist (${existing.slice(0, 3).map((path) => toLogPath(rootDir, path)).join(', ')}${existing.length > 3 ? ', ...' : ''}); remove them first. Nothing was written.`);
    }

    const written = [];
    if (mode === 'preview') {
        const put = (path, bytes) => {
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, bytes);
            written.push(toLogPath(rootDir, path));
        };
        for (const { prepared } of Object.values(built)) {
            put(prepared.absoluteOut, prepared.png);
        }
        for (const frame of frames) {
            put(absoluteIn(rootDir, frame.masterPath), frame.masterBytes);
            put(frame.prepared.absoluteOut, frame.prepared.png);
            put(join(rootDir, locations.masterDir, `${frame.id}--cut.png`), frame.cutBytes);
        }
        for (const { file, bytes } of sceneOut) {
            put(join(rootDir, locations.sceneDir, file), bytes);
        }
        const galleryPath = join(rootDir, ...GALLERY_FILE.split('/'));
        put(galleryPath, renderSplashGallery({ manifest, frames: frames.map(({ id, name, base, check, composed }) => ({ id, name, base, changed: check.changed, box: check.box, cut: countOf(composed.cut) })), version: now().getTime() }));
        return { ...result, written };
    }

    let logged = 0;
    const log = (entry) => {
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), entry);
        logged++;
    };
    const commit = (prepared) => {
        const done = commitSnap(prepared, { rootDir, stage, now });
        written.push(done.file);
        logged++;
    };
    for (const { prepared } of Object.values(built)) {
        commit(prepared);
    }
    for (const frame of frames) {
        mkdirSync(join(absoluteIn(rootDir, frame.masterPath), '..'), { recursive: true });
        writeFileSync(absoluteIn(rootDir, frame.masterPath), frame.masterBytes, { flag: 'wx' });
        written.push(toLogPath(rootDir, absoluteIn(rootDir, frame.masterPath)));
        log(logEntryFor({
            now,
            stage,
            model: 'frame-compose',
            vars: frame.logVars,
            refs: frame.refs,
            size: `${frame.composed.raster.width}x${frame.composed.raster.height}`,
            outputs: [{ file: toLogPath(rootDir, absoluteIn(rootDir, frame.masterPath)), sha256: sha256(frame.masterBytes) }],
        }));
        commit(frame.prepared);
    }
    mkdirSync(join(rootDir, locations.sceneDir), { recursive: true });
    const sceneFolder = toLogPath(rootDir, join(rootDir, locations.sceneDir));
    for (const layer of scene.layers) {
        const own = sceneFiles.filter(({ layer: id }) => id === layer.id);
        const sources = [built[layer.id].snap, ...frames.filter(({ base }) => base === layer.id).map(({ prepared }) => ({ sha256: sha256(prepared.png) }))];
        for (const { file, bytes } of own) {
            writeFileSync(join(rootDir, locations.sceneDir, file), bytes, { flag: 'wx' });
            written.push(`${sceneFolder}/${file}`);
        }
        log(logEntryFor({
            now,
            stage,
            model: 'splash-frames',
            vars: { kind: 'layer', scene: config.scene.id, layer: layer.id, placement: { left: layer.left, top: layer.top, width: layer.width, height: layer.height, z: layer.z }, poses: [...layer.frames.keys()], config: configInfo },
            refs: sources.map(({ sha256: hash }) => hash),
            size: `${layer.width}x${layer.height}`,
            outputs: own.map(({ file, bytes }) => ({ file: `${sceneFolder}/${file}`, sha256: sha256(bytes) })),
        }));
    }
    for (const { file, bytes } of sceneOut.filter(({ file }) => file.startsWith(`${config.scene.id}.`) || file.endsWith('.json'))) {
        writeFileSync(join(rootDir, locations.sceneDir, file), bytes, { flag: 'wx' });
        written.push(`${sceneFolder}/${file}`);
    }
    log(logEntryFor({
        now,
        stage,
        model: 'splash-frames',
        vars: { kind: 'scene', scene: config.scene.id, grid: manifest.grid, margin: scene.margin, gap: scene.gap, layers: manifest.layers.map(({ id, z, left, top }) => ({ id, z, left, top })), config: configInfo },
        refs: [...Object.values(built).map(({ snap }) => snap.sha256), ...frames.map(({ prepared }) => sha256(prepared.png))],
        size: `${scene.width}x${scene.height}`,
        outputs: [`${config.scene.id}.png`, `${config.scene.id}--anim.json`].map((file) => ({ file: `${sceneFolder}/${file}`, sha256: sha256(file.endsWith('.json') ? manifestBytes : neutralBytes) })),
    }));
    return { ...result, written, logged };
}
