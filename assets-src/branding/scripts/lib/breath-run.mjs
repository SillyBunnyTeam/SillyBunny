import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BREATH_CONFIG_FILE, loadBreathConfig } from './breath-config.mjs';
import { renderBreathGallery } from './breath-gallery.mjs';
import { buildBreath, countOrphans } from './breath-pose.mjs';
import { composeBackdrop, drawScene, exportLayer, loadScene, readStillWithBlinks } from './breath-scene.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { measureRings, STICKER_BAND, STICKER_RIM } from './pixel-snap.mjs';
import { encodePng } from './raster.mjs';
import { resolveOutDir } from './run.mjs';
import { configuredRingWidths } from './snap-config.mjs';

export const PREVIEW_DIR = 'out/breath';
export const GALLERY_FILE = 'out/gallery/breath.html';


/** The name of a pose picture: `<prefix>--breath-b.png`, `<prefix>--breath-b-half.png`, `<prefix>--breath-b-closed.png`. */
export const poseFileName = (prefix, pose, variant) => `${prefix}--breath-${pose}${variant === 'base' ? '' : `-${variant}`}.png`;

/** The ring widths to rebuild with: snap-config.json's, which every snapped still must already have, or the still's own when the config sets none. */
function ringsOf(base, configured, name) {
    const measured = measureRings(base, { rim: STICKER_RIM, band: STICKER_BAND });
    if (configured.rimWidth === undefined) {
        return measured;
    }
    if (measured.rimWidth !== configured.rimWidth || measured.bandWidth !== configured.bandWidth) {
        throw new Error(`${name}: its rings are ${measured.rimWidth}+${measured.bandWidth} art pixels but snap-config.json says ${configured.rimWidth}+${configured.bandWidth}, so rebuilding them after the breath shift would change the sticker. Snap it again.`);
    }
    return configured;
}

/** What a run logs about how a still was made, so the pictures can be explained from the log alone. */
function breathVars({ built, config, sourceOrphans }) {
    const pose = built.poses[1];
    return {
        algorithm: 'every row above the waist one row down, the rows from the waist down unchanged, the waist row drawn over the moved row, band and rim rebuilt',
        waistShare: config.waist,
        waist: built.waist,
        figureTop: built.box.y,
        figureBottom: built.box.y + built.box.height - 1,
        rings: built.rings,
        outlineFixed: pose.variants.base.outlineFixed,
        ringsChanged: Object.fromEntries(Object.entries(pose.variants).map(([variant, { ringsChanged }]) => [variant, ringsChanged])),
        orphans: countOrphans(pose.variants.base.raster),
        orphansOfSource: sourceOrphans,
        rhythm: { cycleSeconds: config.cycleSeconds, breathsPerCycle: config.breathsPerCycle },
    };
}

function breatheStill({ name, pictures, config, configuredRings }) {
    const variants = Object.fromEntries(Object.entries(pictures).map(([variant, { raster }]) => [variant, raster]));
    const rings = ringsOf(variants.base, configuredRings, name);
    const built = buildBreath({ variants, waistShare: config.waist, rings });
    return { built, vars: breathVars({ built, config, sourceOrphans: countOrphans(variants.base) }) };
}

/** A single still: its breath pose at the still's own size, the pose `c` being the approved still itself. */
async function planStill({ rootDir, id, config, configuredRings }) {
    const pictures = await readStillWithBlinks(rootDir, id);
    const { built, vars } = breatheStill({ name: id, pictures, config, configuredRings });
    const images = new Map([['b', Object.fromEntries(Object.entries(built.poses[1].variants).map(([variant, { raster }]) => [variant, raster]))]]);
    const { raster } = pictures.base;
    const layer = {
        id,
        z: 0,
        order: 0,
        left: 0,
        top: 0,
        width: raster.width,
        height: raster.height,
        waist: built.waist,
        stills: Object.fromEntries(Object.entries(pictures).map(([variant, { file }]) => [variant, file])),
        files: new Map([...images].map(([pose, byVariant]) => [pose, Object.fromEntries(Object.keys(byVariant).map((variant) => [variant, poseFileName(id, pose, variant)]))])),
        images,
    };
    const job = {
        label: id,
        refs: Object.values(pictures).map(({ sha256: hash }) => hash),
        size: `${raster.width}x${raster.height}`,
        vars: { id, kind: 'still', source: pictures.base.file, variants: Object.keys(pictures), ...vars },
        pictures: [...images].flatMap(([pose, byVariant]) => Object.entries(byVariant).map(([variant, picture]) => ({ file: poseFileName(id, pose, variant), picture }))),
    };
    return { model: { id, kind: 'still', width: raster.width, height: raster.height, backdrop: null, layers: [layer] }, jobs: [job], problems: built.problems.map((problem) => `${id}: ${problem}`) };
}

/** A grid scene: each figure's poses as layer images with a placement, and the scene without its figures as the backdrop. */
async function planScene({ rootDir, id, config, configuredRings }) {
    const scene = await loadScene({ rootDir, scene: id });
    const backdropRaster = composeBackdrop(scene);
    const backdropFile = backdropRaster ? `${id}--backdrop.png` : null;
    const problems = [];
    const layers = [];
    const jobs = [];
    for (const figure of scene.figures) {
        const layerName = `${id}/${figure.layer.id}`;
        const { built, vars } = breatheStill({ name: layerName, pictures: figure.pictures, config, configuredRings });
        problems.push(...built.problems.map((problem) => `${layerName}: ${problem}`));
        const placement = scene.placements.get(figure.layer.id);
        const exported = exportLayer({ built, placement, grade: figure.layer.grade });
        const prefix = `${id}--${figure.layer.id}`;
        const layer = {
            id: figure.layer.id,
            z: figure.layer.z,
            order: figure.index,
            left: exported.left,
            top: exported.top,
            width: exported.width,
            height: exported.height,
            waist: exported.waist,
            stills: Object.fromEntries(Object.entries(figure.pictures).map(([variant, { file }]) => [variant, file])),
            files: new Map([...exported.images].map(([pose, byVariant]) => [pose, Object.fromEntries(Object.keys(byVariant).map((variant) => [variant, poseFileName(prefix, pose, variant)]))])),
            images: exported.images,
        };
        layers.push(layer);
        jobs.push({
            label: layerName,
            refs: Object.values(figure.pictures).map(({ sha256: hash }) => hash),
            size: `${exported.width}x${exported.height}`,
            vars: {
                id: figure.still,
                kind: 'layer',
                scene: id,
                layer: figure.layer.id,
                source: figure.pictures.base.file,
                variants: Object.keys(figure.pictures),
                placement: { left: exported.left, top: exported.top, width: exported.width, height: exported.height, z: figure.layer.z },
                ...(figure.layer.grade ? { grade: figure.layer.grade } : {}),
                ...vars,
            },
            pictures: [...exported.images].flatMap(([pose, byVariant]) => Object.entries(byVariant).map(([variant, picture]) => ({ file: poseFileName(prefix, pose, variant), picture }))),
        });
    }
    const drawn = drawScene({ grid: scene.grid, backdrop: backdropRaster, layers, pose: 'c' });
    if (!drawn.data.equals(scene.scene.raster.data)) {
        throw new Error(`${id}: the layer images of the centre pose, drawn at their placements over the backdrop, are not ${scene.scene.file}. The export is wrong; nothing was written.`);
    }
    const manifest = {
        scene: id,
        grid: scene.grid,
        rhythm: { cycleSeconds: config.cycleSeconds, breathsPerCycle: config.breathsPerCycle },
        poses: ['c', 'b'],
        backdrop: backdropFile,
        layers: [...layers].sort((a, b) => a.z - b.z || a.order - b.order).map((layer) => ({
            id: layer.id,
            z: layer.z,
            source: layer.stills.base,
            left: layer.left,
            top: layer.top,
            width: layer.width,
            height: layer.height,
            waist: layer.waist,
            images: Object.fromEntries(layer.files),
        })),
    };
    const sceneRefs = [...scene.figures, ...scene.statics].flatMap(({ pictures }) => Object.values(pictures).map(({ sha256: hash }) => hash));
    jobs.push({
        label: `${id} (backdrop and layout)`,
        refs: [...new Set([...sceneRefs, scene.scene.sha256])],
        size: `${scene.grid.width}x${scene.grid.height}`,
        vars: { kind: 'scene', scene: id, source: scene.scene.file, layers: manifest.layers.map(({ id: layerId, z }) => ({ id: layerId, z })), grid: scene.grid, backdrop: backdropFile, recomposed: 'identical to the approved scene' },
        pictures: backdropRaster ? [{ file: backdropFile, picture: backdropRaster }] : [],
        json: [{ file: `${id}--breath.json`, value: manifest }],
    });
    return { model: { id, kind: 'scene', width: scene.grid.width, height: scene.grid.height, backdrop: backdropFile ? { file: backdropFile, raster: backdropRaster } : null, layers }, jobs, problems };
}

/**
 * Makes the breath poses of the stills and grid scenes named (or, with none named, the ones breath-config.json lists). `mode` is `dry-run`
 * (build and check in memory, write nothing), `preview` (write the pictures to out/breath/ and the page that plays them to out/gallery/breath.html,
 * log nothing) or `build` (write raw/<stage>/pixel-body/breath/ and log one local `breath-frames` line for each source picture, with its sha256
 * in `refs`). Everything is built and checked before the first file is written, so a pose that is wrong writes nothing.
 * @param {{ rootDir: string, stills?: string[], scenes?: string[], mode: 'dry-run' | 'preview' | 'build', stage?: string, now: () => Date }} request
 */
export async function runBreath({ rootDir, stills, scenes, mode, stage, now }) {
    if (mode === 'build' && !stage) {
        throw new Error('Pass --stage (such as s5) for a run that is logged, or --dry-run or --preview.');
    }
    const config = loadBreathConfig(rootDir);
    const named = stills !== undefined || scenes !== undefined;
    const stillIds = named ? stills ?? [] : config.stills;
    const sceneIds = named ? scenes ?? [] : config.scenes;
    if (stillIds.length + sceneIds.length === 0) {
        throw new Error('There is nothing to make: name a --still or a --scene, or list some in breath-config.json.');
    }
    const configuredRings = configuredRingWidths(rootDir);
    const planned = [];
    for (const id of stillIds) {
        planned.push(await planStill({ rootDir, id, config, configuredRings }));
    }
    for (const id of sceneIds) {
        planned.push(await planScene({ rootDir, id, config, configuredRings }));
    }
    const problems = planned.flatMap((one) => one.problems);
    if (problems.length > 0) {
        throw new Error(`Some poses are wrong, so nothing was written:\n  ${problems.join('\n  ')}`);
    }
    const models = planned.map(({ model }) => model);
    const jobs = planned.flatMap((one) => one.jobs);
    if (mode === 'dry-run') {
        return { models, jobs, written: [], logged: 0 };
    }

    const folder = mode === 'preview' ? PREVIEW_DIR : `raw/${stage}/pixel-body/breath`;
    const outDir = resolveOutDir(rootDir, folder);
    const files = [];
    for (const job of jobs) {
        job.outputs = [];
        for (const { file, picture } of job.pictures) {
            job.outputs.push({ file, bytes: await encodePng(picture) });
        }
        for (const { file, value } of job.json ?? []) {
            job.outputs.push({ file, bytes: Buffer.from(`${JSON.stringify(value, null, 4)}\n`) });
        }
        files.push(...job.outputs.map(({ file }) => file));
    }
    const existing = files.filter((file) => existsSync(join(outDir, file)));
    if (mode === 'build' && existing.length > 0) {
        throw new Error(`${existing.length} of the files already exist in ${folder}/ (${existing.slice(0, 3).join(', ')}${existing.length > 3 ? ', ...' : ''}); remove them first. Nothing was written.`);
    }
    mkdirSync(outDir, { recursive: true });
    for (const job of jobs) {
        for (const { file, bytes } of job.outputs) {
            writeFileSync(join(outDir, file), bytes);
        }
    }
    const written = files.map((file) => `${folder}/${file}`);
    if (mode === 'preview') {
        const galleryPath = join(rootDir, ...GALLERY_FILE.split('/'));
        mkdirSync(join(galleryPath, '..'), { recursive: true });
        writeFileSync(galleryPath, renderBreathGallery({ models, rhythm: { cycleSeconds: config.cycleSeconds, breathsPerCycle: config.breathsPerCycle }, version: now().getTime() }));
        return { models, jobs, written: [...written, GALLERY_FILE], logged: 0 };
    }
    const configSha256 = sha256(readFileSync(join(rootDir, BREATH_CONFIG_FILE)));
    for (const job of jobs) {
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage,
            provider: 'local',
            model: 'breath-frames',
            template: 'breath-frames',
            vars: { ...job.vars, config: { file: BREATH_CONFIG_FILE, sha256: configSha256 } },
            refHashes: job.refs,
            size: job.size,
            outputs: job.outputs.map(({ file, bytes }) => ({ file: `${folder}/${file}`, sha256: sha256(bytes) })),
            estimatedUsd: 0,
        }));
    }
    return { models, jobs, written, logged: jobs.length };
}
