import { posix } from 'node:path';
import { cellIndex } from './fit.js';
import { frameBox } from './frame.js';
import { masterFile, parseRatio } from './manifest.js';
import { placementOf } from './placement.js';
import { ArtProblem } from './problem.js';
import { readRaster } from './raster.js';

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const PICTURE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.png$/;
const BLINK_EYES = Object.freeze(['half', 'closed']);
const EFFECT_KINDS = Object.freeze(['rings', 'burst', 'puff']);
const POSES = Object.freeze(['c', 'b']);
const VARIANTS = Object.freeze(['base', ...BLINK_EYES]);
// A splash loop's one layer draws the same at any z; the shipped descriptions give it 1.
const SPLASH_LAYER_Z = 1;

/**
 * Whether a motion master is the description that a run of the art pipeline left. The derive builds the player's
 * description from it; a player's own description, which the shipped art was adopted with, has no `kind` and ships as
 * it is.
 * @param {any} description
 */
export const isRunDescription = (description) => isPlainObject(description) && Object.hasOwn(description, 'kind');

/**
 * The description an animation's player reads, built from the description its run left and the files its asset ships.
 * Each picture of the run is the asset's picture whose master has the run's file name. The fields that no run gives
 * come from the asset's `motion`: `cell`, the source pixels per art pixel that the description records, and, for a
 * splash loop, `layer`, the id of its one layer (the asset's id when left out).
 * @param {{ root: string, id: string }} context
 * @param {any} asset A valid manifest asset with a `motion`.
 * @param {any} run The parsed motion master.
 * @returns {Promise<{ description: object, bytes: Buffer }>}
 * @throws {ArtProblem} `motion-invalid` when the run's description is not one the derive can build from;
 *   `motion-mismatch` when it does not fit the asset.
 */
export async function buildPlayerDescription({ root, id }, asset, run) {
    const fail = (code, message) => {
        throw new ArtProblem(code, `${asset.motion.master}: ${message}`, { asset: id, path: asset.motion.master });
    };
    const builder = BUILDERS[run.kind];
    if (run.format !== 1 || !builder) {
        fail('motion-invalid', `it is a run's description of the kind ${JSON.stringify(run.kind)} in format ${JSON.stringify(run.format)}, and the derive builds only format 1 of ${Object.keys(BUILDERS).join(', ')}.`);
    }
    const ratio = parseRatio(asset.ratio);
    if (ratio.p < ratio.q) {
        fail('motion-invalid', `the asset is placed at the ratio ${asset.ratio}, and a player's description is built at ratio 1 or for a fit, which takes more master pixels than placement pixels.`);
    }
    const description = await builder({ root, id, asset, run, fail, ratio });
    return { description, bytes: Buffer.from(`${JSON.stringify(description, null, 4)}\n`) };
}

const BUILDERS = Object.freeze({ 'splash-loop': splashDescription, 'motion-frames': breathDescription });

/**
 * The `--anim.json` of the splash player: one layer that holds every frame, its timeline with the effects in its own
 * pixels, and the blink.
 */
async function splashDescription({ root, id, asset, run, fail, ratio }) {
    if (asset.type !== 'still' || !isPlainObject(asset.frames)) {
        fail('motion-mismatch', `a splash loop's description belongs to a still with frames, and ${id} is a ${asset.type}${asset.frames ? '' : ' with no frames'}.`);
    }
    const frames = runFrames(run, fail);
    if (!NAME_PATTERN.test(run.base ?? '') || !Object.hasOwn(frames, run.base)) {
        fail('motion-invalid', `base must name the frame that the loop's base picture is, one of ${Object.keys(frames).join(', ')}.`);
    }
    matchFrames(asset, frames, fail);
    const timeline = runTimeline(run.timeline, frames, fail);
    const opening = timeline.keys[0].frame;
    const repeated = (asset.outputs ?? []).find((output) => output.from !== undefined);
    if (repeated && repeated.from !== opening) {
        fail('motion-mismatch', `the timeline opens on ${opening}, but the still repeats the frame ${repeated.from}, so the loop would not start on the still.`);
    }
    const blink = runBlink(run.blink, frames, fail);
    const layer = asset.motion.layer ?? id;
    const origin = await originOf(root, id, asset, asset.master ?? asset.frames[run.base].master);
    const [width, height] = asset.grid;
    return {
        id,
        grid: gridOf(asset),
        layers: [{
            id: layer,
            z: SPLASH_LAYER_Z,
            left: 0,
            top: 0,
            width,
            height,
            base: opening,
            frames: Object.fromEntries(Object.entries(asset.frames).map(([name, frame]) => [name, shippedName(frame, `the frame ${name}`, fail)])),
        }],
        timelines: {
            [layer]: {
                seconds: timeline.seconds,
                keys: timeline.keys.map(({ at, frame }) => ({ at, frame })),
                effects: timeline.effects.map((effect) => ({
                    kind: effect.kind,
                    frames: [...effect.frames],
                    // The player counts an effect's age from the first key that shows one of its frames.
                    from: timeline.keys.find(({ frame }) => effect.frames.includes(frame)).at,
                    x: cellIndex(effect.x, ratio) - origin.x,
                    y: cellIndex(effect.y, ratio) - origin.y,
                })),
            },
        },
        ...(blink ? { blinks: { ...playerBlink(blink), never: blink.never.length > 0 ? { [layer]: [...blink.never] } : {} } } : {}),
    };
}

/**
 * The `--breath.json` of the breath player. A scene's figure layers lie at their boxes in the scene's still; a still is
 * its own one layer, with itself and its blink frames as the pose `c` and its breath frames as the pose `b`.
 */
async function breathDescription({ root, id, asset, run, fail, ratio }) {
    const { breath } = run;
    const rhythm = breath?.rhythm;
    const validRhythm = isPlainObject(rhythm) && typeof rhythm.cycleSeconds === 'number' && rhythm.cycleSeconds > 0
        && Number.isInteger(rhythm.breathsPerCycle) && rhythm.breathsPerCycle >= 1;
    if (!isPlainObject(breath) || !validRhythm) {
        fail('motion-invalid', 'breath must give the rhythm of the breath, cycleSeconds above 0 and a whole breathsPerCycle of 1 or more, which the breath player needs.');
    }
    const blinkFrames = runBlinkFrames(run, fail);
    const blink = runBlink(run.blink, {}, fail);
    const { backdrop, layers } = asset.type === 'scene'
        ? await sceneLayers({ root, id, asset, breath, fail, ratio })
        : await stillLayers({ root, id, asset, breath, blinkFrames, fail, ratio });
    return {
        scene: id,
        grid: gridOf(asset),
        rhythm: { cycleSeconds: rhythm.cycleSeconds, breathsPerCycle: rhythm.breathsPerCycle },
        poses: [...POSES],
        backdrop,
        layers,
        ...(blink ? { blinks: playerBlink(blink) } : {}),
    };
}

/**
 * A scene's figure layers. The run cut them on the scene master's canvas, so a layer's place there, less the top left
 * of the still's frame, must be its box.
 */
async function sceneLayers({ root, id, asset, breath, fail, ratio }) {
    const valid = Array.isArray(breath.layers) && breath.layers.every((layer) => isPlainObject(layer) && NAME_PATTERN.test(layer.id ?? '')
        && ['z', 'left', 'top', 'width', 'height', 'waist'].every((key) => Number.isInteger(layer[key])) && isPlainObject(layer.images));
    if (!valid) {
        fail('motion-invalid', 'breath.layers must give each figure layer with its id, whole z, left, top, width, height and waist, and its images.');
    }
    const ids = Object.keys(asset.layers);
    const given = breath.layers.map(({ id }) => id);
    if (given.length !== ids.length || !ids.every((id) => given.includes(id))) {
        fail('motion-mismatch', `the run gives the layers ${given.join(', ')}, but the scene's layers are ${ids.join(', ')}.`);
    }
    const master = await readRaster(masterFile(root, asset.master));
    if (breath.grid?.width !== master.width || breath.grid?.height !== master.height) {
        fail('motion-mismatch', `the run cut the breath on a ${breath.grid?.width}x${breath.grid?.height} canvas, but the scene's master is ${master.width}x${master.height}.`);
    }
    const origin = await originOf(root, id, asset, asset.master);
    if ((breath.backdrop ?? null) !== (asset.backdrop ? posix.basename(asset.backdrop.master) : null)) {
        fail('motion-mismatch', `the run's backdrop is ${breath.backdrop ?? 'none'}, but the scene's is ${asset.backdrop?.master ?? 'none'}.`);
    }
    const layers = breath.layers.map((layer) => {
        const { box, pictures } = asset.layers[layer.id];
        const placed = [layer.left - origin.x, layer.top - origin.y, layer.width, layer.height];
        // At a fit the box is the derive's own measure on the placement grid, so the run's place in master pixels has nothing to match.
        if (ratio.p === ratio.q && placed.some((value, at) => value !== box[at])) {
            fail('motion-mismatch', `the run placed the layer ${layer.id} at ${placed.join(', ')} of the scene's still, but its box is ${box.join(', ')}.`);
        }
        const namer = pictureNamer(pictures, `the layer ${layer.id}`, fail);
        const images = Object.fromEntries(POSES.map((pose) => [pose, namedStates(poseFiles(layer.images, pose, `the layer ${layer.id}`, fail), namer.nameOf)]));
        namer.checkAllMade();
        const waist = cellIndex(layer.top + layer.waist, ratio) - origin.y - box[1];
        return { id: layer.id, z: layer.z, left: box[0], top: box[1], width: box[2], height: box[3], waist, images };
    });
    return { backdrop: asset.backdrop ? shippedName(asset.backdrop, 'the backdrop', fail) : null, layers };
}

/**
 * A still as its one layer: the pose `c` is the still and its blink frames, and the pose `b` its breath frames. The run
 * counts the waist in rows of the master, and the shipped still starts at the top of its frame.
 */
async function stillLayers({ root, id, asset, breath, blinkFrames, fail, ratio }) {
    if (asset.type !== 'still' || typeof asset.master !== 'string' || !isPlainObject(asset.frames)) {
        fail('motion-mismatch', `a breath belongs to a scene or to a still with a master and frames, and ${id} is a ${asset.type}${asset.master ? '' : ' with no master'}.`);
    }
    if (!Number.isInteger(breath.waist)) {
        fail('motion-invalid', 'breath must give the still\'s waist row.');
    }
    const { y: top } = await originOf(root, id, asset, asset.master);
    const namer = pictureNamer(asset.frames, 'the still', fail);
    const blinks = Object.fromEntries(Object.values(blinkFrames).filter((frame) => frame.layer === undefined).map(({ eyes, file }) => [eyes, file]));
    const c = { base: shippedName({ outputs: asset.outputs.filter((output) => output.from === undefined) }, 'the still', fail), ...namedStates(blinks, namer.nameOf) };
    const b = namedStates(poseFiles(breath.images, 'b', 'the still', fail), namer.nameOf);
    namer.checkAllMade();
    const [width, height] = asset.grid;
    return { backdrop: null, layers: [{ id, z: 0, left: 0, top: 0, width, height, waist: cellIndex(breath.waist, ratio) - top, images: { c, b } }] };
}

/** The run's file names of one pose: a base, and a picture for any blink state the run drew. */
function poseFiles(images, pose, where, fail) {
    const states = isPlainObject(images) ? images[pose] : undefined;
    if (!isPlainObject(states) || typeof states.base !== 'string' || !Object.keys(states).every((state) => VARIANTS.includes(state))) {
        fail('motion-invalid', `${where} needs images of the pose ${pose}: a base and any of ${BLINK_EYES.join(', ')}.`);
    }
    return states;
}

/** The states of a pose with the names the player loads, in the order base, half, closed. */
const namedStates = (files, nameOf) => Object.fromEntries(VARIANTS.filter((state) => typeof files[state] === 'string').map((state) => [state, nameOf(files[state])]));

/**
 * Finds the asset's picture for each file the run made by the file name of its master, and gives the name the player
 * loads for it. `checkAllMade` refuses an asset picture that no file of the run named, which would ship stale.
 */
function pictureNamer(pictures, where, fail) {
    const byFile = new Map(Object.entries(pictures).map(([name, picture]) => [posix.basename(picture.master), { name, picture }]));
    const made = new Set();
    return {
        nameOf(file) {
            const found = byFile.get(file);
            if (!found) {
                fail('motion-mismatch', `the run made ${file} for ${where}, which has no picture with that master.`);
            }
            made.add(found.name);
            return shippedName(found.picture, `${where}'s picture ${found.name}`, fail);
        },
        checkAllMade() {
            const unmade = Object.keys(pictures).filter((name) => !made.has(name));
            if (unmade.length > 0) {
                fail('motion-mismatch', `${where} has the pictures ${unmade.join(', ')}, which the run did not make.`);
            }
        },
    };
}

/** The blink frames of a run of motion frames, each with its picture's file name, its eyes and, in a scene, its layer. */
function runBlinkFrames(run, fail) {
    const frames = run.frames ?? {};
    const valid = isPlainObject(frames) && Object.entries(frames).every(([name, frame]) => NAME_PATTERN.test(name) && isPlainObject(frame)
        && PICTURE_FILE_PATTERN.test(frame.file ?? '') && BLINK_EYES.includes(frame.eyes) && (frame.layer === undefined || NAME_PATTERN.test(frame.layer)));
    if (!valid) {
        fail('motion-invalid', `frames must give each blink frame as { "file": "<name>.png", "eyes": ${BLINK_EYES.join(' or ')} }, with the layer it changes in a scene.`);
    }
    return frames;
}

function runFrames(run, fail) {
    const valid = isPlainObject(run.frames) && Object.keys(run.frames).length > 0
        && Object.entries(run.frames).every(([name, frame]) => NAME_PATTERN.test(name) && isPlainObject(frame) && PICTURE_FILE_PATTERN.test(frame.file ?? ''));
    if (!valid) {
        fail('motion-invalid', 'frames must name at least one frame, each as { "file": "<name>.png" }.');
    }
    return run.frames;
}

/**
 * Every frame of the run is the frame of the asset with the same name, whose master has the run's file name, and the
 * asset has no other frame.
 */
function matchFrames(asset, frames, fail) {
    const names = Object.keys(frames);
    const extra = Object.keys(asset.frames).filter((name) => !names.includes(name));
    if (extra.length > 0) {
        fail('motion-mismatch', `the still has the frames ${extra.join(', ')}, which the run did not make.`);
    }
    for (const [name, { file }] of Object.entries(frames)) {
        const frame = asset.frames[name];
        if (!frame) {
            fail('motion-mismatch', `the run made the frame ${name}, which the still does not have.`);
        }
        if (posix.basename(frame.master) !== file) {
            fail('motion-mismatch', `the frame ${name} is ${file} in the run, but its master is ${frame.master}.`);
        }
    }
}

function runTimeline(timeline, frames, fail) {
    const isFrame = (name) => Object.hasOwn(frames, name);
    if (!isPlainObject(timeline) || !(typeof timeline.seconds === 'number' && timeline.seconds > 0) || !Array.isArray(timeline.keys) || timeline.keys.length === 0) {
        fail('motion-invalid', 'timeline must give seconds above 0 and at least one key.');
    }
    timeline.keys.forEach((key, index) => {
        const rising = index === 0 ? key?.at === 0 : key?.at > timeline.keys[index - 1].at;
        if (!isPlainObject(key) || typeof key.at !== 'number' || !rising || key.at >= timeline.seconds || !isFrame(key.frame)) {
            fail('motion-invalid', `key ${index} must show a frame of the run at a time that rises from 0 and stays below ${timeline.seconds} seconds.`);
        }
    });
    const effects = timeline.effects ?? [];
    if (!Array.isArray(effects)) {
        fail('motion-invalid', 'timeline.effects must be a list.');
    }
    effects.forEach((effect, index) => {
        const valid = isPlainObject(effect) && EFFECT_KINDS.includes(effect.kind)
            && Array.isArray(effect.frames) && effect.frames.length > 0 && effect.frames.every(isFrame)
            && timeline.keys.some(({ frame }) => effect.frames.includes(frame))
            && Number.isInteger(effect.x) && Number.isInteger(effect.y);
        if (!valid) {
            fail('motion-invalid', `effect ${index} needs a kind of ${EFFECT_KINDS.join(', ')}, frames that the timeline shows, and x and y in whole pixels of the base picture.`);
        }
    });
    return { seconds: timeline.seconds, keys: timeline.keys, effects };
}

/** The run's blink in the recipe's form, or null when the run has none. */
function runBlink(blink, frames, fail) {
    if (blink === undefined || blink === null) {
        return null;
    }
    const steps = isPlainObject(blink) && Array.isArray(blink.steps) ? blink.steps : [];
    const gap = isPlainObject(blink) ? blink.gapMs : undefined;
    const never = isPlainObject(blink) ? blink.never ?? [] : [];
    const valid = steps.length > 0 && steps.every((step) => isPlainObject(step) && BLINK_EYES.includes(step.eyes) && Number.isInteger(step.ms) && step.ms >= 1)
        && isPlainObject(gap) && Number.isInteger(gap.min) && Number.isInteger(gap.max) && gap.min >= 1 && gap.max >= gap.min
        && Array.isArray(never) && never.every((name) => Object.hasOwn(frames, name));
    if (!valid) {
        fail('motion-invalid', `blink must give steps of eyes ${BLINK_EYES.join(' or ')} with whole ms of 1 or more, gapMs as { min, max } with max at least min, and never as frames of the run.`);
    }
    return { steps, gapMs: gap, never };
}

/** A blink in the form both players read. */
const playerBlink = ({ steps, gapMs }) => ({ steps: steps.map(({ eyes, ms }) => ({ variant: eyes, ms })), gapMs: [gapMs.min, gapMs.max] });

function gridOf(asset) {
    const [width, height] = asset.grid;
    return { ...(asset.motion.cell === undefined ? {} : { cell: asset.motion.cell }), width, height };
}

/** The file name the player loads for a picture: its output at scale 1. */
function shippedName(picture, what, fail) {
    const output = picture.outputs.find(({ scale }) => (scale ?? 1) === 1);
    if (!output) {
        fail('motion-mismatch', `${what} has no output at scale 1 for the player to load.`);
    }
    return posix.basename(output.path);
}

/**
 * Where the asset's shipped picture starts on its placement grid: the top left of its frame, cut from `master` once it
 * is placed. The run counts in the master's pixels, which `cellIndex` brings onto that grid.
 */
async function originOf(root, id, asset, master) {
    if (asset.frame.mode === 'canvas') {
        return { x: 0, y: 0 };
    }
    const placed = placementOf({ id }, asset)(await readRaster(masterFile(root, master)));
    const box = frameBox(placed, asset.frame);
    return { x: box.x, y: box.y };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
