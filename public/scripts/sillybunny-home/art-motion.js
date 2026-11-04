/*
 * The idle motion of a picture that is made of figures on a backdrop: each figure breathes, and blinks now and then.
 * The pictures are pre-rendered. A figure has a neutral pose `c` and a breath pose `b`, and for each pose a base picture
 * and, where the eyes were drawn, `half` and `closed` pictures for a blink. This module reads the description that
 * `breath-frames.mjs` writes next to them (`<scene>--breath.json`) and works out which picture of each figure shows at
 * a given time. It has no DOM and no clock, so the timing is tested by giving it numbers.
 *
 * The timing is the contract of that file: a figure is in its breath pose for the first half of a breath and one behind
 * the one before it by a fixed phase, and the first blink of each figure is staggered so that two never blink together.
 */

/** @typedef {'c' | 'b'} BreathPose */
/** @typedef {'base' | 'half' | 'closed'} BlinkVariant */
/**
 * @typedef {object} MotionLayer
 * @property {string} id
 * @property {number} z
 * @property {number} left Art pixels from the left of the scene.
 * @property {number} top Art pixels from the top of the scene.
 * @property {number} width
 * @property {number} height
 * @property {number} waist
 * @property {Record<BreathPose, Partial<Record<BlinkVariant, string>> & { base: string }>} images File names.
 */
/**
 * @typedef {object} BlinkPlan
 * @property {{ variant: BlinkVariant, ms: number }[]} steps The pictures of one blink, in order. The base picture follows the last.
 * @property {[number, number]} gapMs The shortest and the longest wait between two blinks.
 */
/**
 * @typedef {object} MotionScene
 * @property {string} scene
 * @property {number} width Art pixels.
 * @property {number} height Art pixels.
 * @property {number} breathMs How long one breath takes: half of it in the neutral pose, half in the breath pose.
 * @property {string | null} backdrop File name of what does not move, drawn below every layer.
 * @property {MotionLayer[]} layers In drawing order, lowest first.
 * @property {BlinkPlan} blink
 */

/** The eyes close and open again in a fraction of a second. A scene that writes its own `blinks` replaces all of this. */
export const DEFAULT_BLINK = Object.freeze({
    steps: Object.freeze([
        Object.freeze({ variant: 'half', ms: 70 }),
        Object.freeze({ variant: 'closed', ms: 110 }),
        Object.freeze({ variant: 'half', ms: 70 }),
    ]),
    gapMs: Object.freeze([3600, 5400]),
});

/** The first blink of a figure is due this long after the scene starts, plus a draw of up to the spread, and each figure a stagger later than the one before. */
export const FIRST_BLINK_MS = 1000;
export const FIRST_BLINK_SPREAD_MS = 1000;
export const BLINK_STAGGER_MS = 1700;
/** A figure does not start a blink until every other has had its eyes open for this long. */
export const BLINK_CLEARANCE_MS = 400;
/** Each figure is this far into its breath behind the one before, as a share of a breath: a step of 1.7 radians. */
export const BREATH_PHASE_STEP = 1.7 / (2 * Math.PI);

const BLINK_VARIANTS = ['base', 'half', 'closed'];
/** A blink shows the eyes partly or fully closed; the base picture is what follows it. */
const BLINK_STEP_VARIANTS = ['half', 'closed'];
const POSES = ['c', 'b'];

/**
 * @param {unknown} value
 * @param {string} what
 * @param {{ min?: number }} [limits]
 * @returns {number}
 */
function parseInteger(value, what, { min = 0 } = {}) {
    if (!Number.isInteger(value) || /** @type {number} */ (value) < min) {
        throw new Error(`${what} must be a whole number of at least ${min}, got ${JSON.stringify(value)}.`);
    }
    return /** @type {number} */ (value);
}

/**
 * A name goes into a URL without any change, so a path, a query, a fragment, an escape or a name that starts with a dot
 * would reach something other than the picture that was meant.
 */
const PLAIN_FILE_NAME = /^[\w@-][\w.@-]*$/;

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function parseFileName(value, what) {
    if (typeof value !== 'string' || !PLAIN_FILE_NAME.test(value)) {
        throw new Error(`${what} must be a file name of letters, digits and _ . @ -, with no folder and not starting with a dot, got ${JSON.stringify(value)}.`);
    }
    return value;
}

/** @param {unknown} images */
function parseImages(images, where) {
    const parsed = {};
    for (const pose of POSES) {
        const byVariant = /** @type {Record<string, unknown> | undefined} */ (images)?.[pose];
        if (!byVariant || typeof byVariant !== 'object') {
            throw new Error(`${where} has no pictures for the pose "${pose}".`);
        }
        const files = { base: parseFileName(/** @type {any} */ (byVariant).base, `${where}, pose "${pose}", base`) };
        for (const [variant, file] of Object.entries(byVariant)) {
            if (!BLINK_VARIANTS.includes(variant)) {
                throw new Error(`${where}, pose "${pose}" has a picture of the unknown kind "${variant}".`);
            }
            files[variant] = parseFileName(file, `${where}, pose "${pose}", ${variant}`);
        }
        parsed[pose] = files;
    }
    return /** @type {MotionLayer['images']} */ (parsed);
}

/** @param {unknown} blinks */
function parseBlink(blinks) {
    if (blinks === undefined || blinks === null) {
        return /** @type {BlinkPlan} */ (DEFAULT_BLINK);
    }
    const { steps, gapMs } = /** @type {{ steps?: unknown, gapMs?: unknown }} */ (blinks);
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error('The blinks of a scene need at least one step.');
    }
    if (!Array.isArray(gapMs) || gapMs.length !== 2) {
        throw new Error('The blinks of a scene need a shortest and a longest wait, gapMs: [min, max].');
    }
    const [shortest, longest] = gapMs.map((value, index) => parseInteger(value, `gapMs[${index}]`, { min: 1 }));
    if (longest < shortest) {
        throw new Error(`The longest wait between blinks (${longest}) is below the shortest (${shortest}).`);
    }
    return {
        steps: steps.map((step, index) => {
            if (!BLINK_STEP_VARIANTS.includes(step?.variant)) {
                throw new Error(`Blink step ${index} shows the unknown kind ${JSON.stringify(step?.variant)}.`);
            }
            return { variant: step.variant, ms: parseInteger(step.ms, `Blink step ${index} ms`, { min: 1 }) };
        }),
        gapMs: [shortest, longest],
    };
}

/**
 * Reads `<scene>--breath.json`. It halts on anything that is not what `breath-frames.mjs` writes, so a bad file shows
 * up as one error here and not as a figure that jumps in the page.
 * @param {unknown} manifest The parsed JSON.
 * @returns {MotionScene}
 */
export function parseBreathScene(manifest) {
    const source = /** @type {Record<string, any>} */ (manifest);
    if (!source || typeof source !== 'object') {
        throw new Error('A breath scene must be an object.');
    }
    const scene = parseFileName(source.scene, 'scene');
    const cycleSeconds = source.rhythm?.cycleSeconds;
    const breathsPerCycle = source.rhythm?.breathsPerCycle;
    if (!(cycleSeconds > 0) || !Number.isInteger(breathsPerCycle) || breathsPerCycle < 1) {
        throw new Error(`${scene}: the rhythm needs a cycleSeconds above 0 and a breathsPerCycle of at least 1.`);
    }
    if (!Array.isArray(source.layers) || source.layers.length === 0) {
        throw new Error(`${scene}: a scene needs at least one layer.`);
    }
    const layers = source.layers.map((layer, index) => {
        const where = `${scene}, layer ${index}`;
        return {
            id: parseFileName(layer.id, `${where} id`),
            z: parseInteger(layer.z, `${where} z`, { min: Number.NEGATIVE_INFINITY }),
            left: parseInteger(layer.left, `${where} left`),
            top: parseInteger(layer.top, `${where} top`),
            width: parseInteger(layer.width, `${where} width`, { min: 1 }),
            height: parseInteger(layer.height, `${where} height`, { min: 1 }),
            waist: parseInteger(layer.waist, `${where} waist`),
            images: parseImages(layer.images, where),
        };
    });
    return {
        scene,
        width: parseInteger(source.grid?.width, `${scene}: grid width`, { min: 1 }),
        height: parseInteger(source.grid?.height, `${scene}: grid height`, { min: 1 }),
        breathMs: (cycleSeconds * 1000) / breathsPerCycle,
        backdrop: source.backdrop === null || source.backdrop === undefined ? null : parseFileName(source.backdrop, `${scene}: backdrop`),
        layers: [...layers].sort((a, b) => a.z - b.z),
        blink: parseBlink(source.blinks),
    };
}

/** @param {number} value */
const fraction = value => ((value % 1) + 1) % 1;

/**
 * The pose of a figure `elapsedMs` into the scene: the breath pose for the first half of a breath, then the neutral
 * pose, with no tweening.
 * @param {number} elapsedMs
 * @param {number} breathMs
 * @param {number} [phase] How far into its breath the figure already is at time zero, as a share of a breath.
 * @returns {BreathPose}
 */
export function breathPoseAt(elapsedMs, breathMs, phase = 0) {
    return fraction(elapsedMs / breathMs + phase) < 0.5 ? 'b' : 'c';
}

/**
 * How long until the pose of a figure changes. Always at least 1, so a timer that fires a hair early still moves on.
 * @param {number} elapsedMs
 * @param {number} breathMs
 * @param {number} [phase]
 * @returns {number}
 */
export function msUntilBreathChange(elapsedMs, breathMs, phase = 0) {
    const within = fraction(elapsedMs / breathMs + phase);
    const toBoundary = within < 0.5 ? 0.5 - within : 1 - within;
    return Math.max(1, Math.ceil(toBoundary * breathMs));
}

/**
 * @param {BlinkPlan} plan
 * @returns {number}
 */
const blinkLengthMs = plan => plan.steps.reduce((sum, step) => sum + step.ms, 0);

/**
 * @typedef {object} FigureBlink
 * @property {number} dueMs When the next blink is due, in ms from the start of the scene. A blink that cannot start yet keeps this.
 * @property {number | null} startMs When the blink that is under way started.
 * @property {number} endMs When the last blink ended.
 */

/**
 * The first blink of every figure that has pictures to blink with, and nothing for one that has none.
 * @param {MotionScene} scene
 * @param {() => number} random A number in [0, 1).
 * @returns {{ layers: (FigureBlink | null)[] }}
 */
export function createBlinkState(scene, random) {
    return {
        layers: scene.layers.map((layer, index) => (canBlink(layer)
            ? { dueMs: FIRST_BLINK_MS + index * BLINK_STAGGER_MS + random() * FIRST_BLINK_SPREAD_MS, startMs: null, endMs: Number.NEGATIVE_INFINITY }
            : null)),
    };
}

/**
 * Where every figure is in its blinks at `elapsedMs`. A due blink starts only when no other figure is blinking and the
 * last blink of each other figure ended at least the clearance ago; until then it waits, and its due time does not
 * move. The next one is due a gap after the start of this one. A blink that was due while the timer slept, as a hidden
 * tab's does, starts when the timer wakes and is not played twice.
 * @param {{ layers: (FigureBlink | null)[] }} state
 * @param {number} elapsedMs
 * @param {BlinkPlan} plan
 * @param {() => number} random A number in [0, 1).
 * @returns {{ state: { layers: (FigureBlink | null)[] }, variants: BlinkVariant[], untilMs: number }} `untilMs` is how long until
 *   something about a blink changes, and is infinite when no figure can blink.
 */
export function stepBlinks(state, elapsedMs, plan, random) {
    const length = blinkLengthMs(plan);
    const [shortest, longest] = plan.gapMs;
    const layers = state.layers.map(layer => (layer ? { ...layer } : null));
    for (const layer of layers) {
        if (layer && layer.startMs !== null && elapsedMs >= layer.startMs + length) {
            layer.endMs = layer.startMs + length;
            layer.startMs = null;
        }
    }
    /** When the eyes of every figure but `index` have been open for the clearance. */
    const clearAt = index => layers.reduce((latest, other, at) => {
        if (at === index || !other) {
            return latest;
        }
        return Math.max(latest, (other.startMs === null ? other.endMs : other.startMs + length) + BLINK_CLEARANCE_MS);
    }, Number.NEGATIVE_INFINITY);
    layers.forEach((layer, index) => {
        if (layer && layer.startMs === null && elapsedMs >= layer.dueMs && elapsedMs >= clearAt(index)) {
            layer.startMs = elapsedMs;
            layer.dueMs = elapsedMs + shortest + Math.floor(random() * (longest - shortest + 1));
        }
    });
    let untilMs = Number.POSITIVE_INFINITY;
    const variants = layers.map((layer, index) => {
        if (!layer) {
            return 'base';
        }
        if (layer.startMs === null) {
            const startsAt = Math.max(layer.dueMs, clearAt(index));
            untilMs = Math.min(untilMs, Math.max(1, Math.ceil(startsAt - elapsedMs)));
            return 'base';
        }
        let stepEnd = layer.startMs;
        for (const { variant, ms } of plan.steps) {
            stepEnd += ms;
            if (elapsedMs < stepEnd) {
                untilMs = Math.min(untilMs, Math.ceil(stepEnd - elapsedMs));
                return variant;
            }
        }
        throw new Error('A blink ended inside its own length. The steps must add up to the length that the loop used.');
    });
    return { state: { layers }, variants, untilMs };
}

/**
 * The picture of a figure for a pose and a blink: the blink's own picture where the figure has one, otherwise the
 * base picture of the pose, so a figure that has no `closed` picture shows its `half` or its base during a blink.
 * @param {MotionLayer} layer
 * @param {BreathPose} pose
 * @param {BlinkVariant} variant
 * @returns {string}
 */
export function pictureOf(layer, pose, variant) {
    const files = layer.images[pose];
    return files[variant] ?? files.half ?? files.base;
}

/**
 * Whether a figure has pictures to blink with. One that has none does not wake a timer for a blink that shows nothing.
 * @param {MotionLayer} layer
 */
export const canBlink = layer => Boolean(layer.images.c.half || layer.images.c.closed);

/**
 * Everything the player needs for the whole scene at one time: the picture each figure shows, the state of the blinks to
 * pass back in, and how long until anything changes.
 * @param {{ layers: (FigureBlink | null)[] }} blinkState
 * @param {number} elapsedMs
 * @param {MotionScene} scene
 * @param {() => number} random
 * @returns {{ files: string[], blinkState: { layers: (FigureBlink | null)[] }, untilMs: number }} `files` is in the order of `scene.layers`.
 */
export function planScene(blinkState, elapsedMs, scene, random) {
    const blinks = stepBlinks(blinkState, elapsedMs, scene.blink, random);
    let untilMs = blinks.untilMs;
    const files = scene.layers.map((layer, index) => {
        const phase = index * BREATH_PHASE_STEP;
        untilMs = Math.min(untilMs, msUntilBreathChange(elapsedMs, scene.breathMs, phase));
        return pictureOf(layer, breathPoseAt(elapsedMs, scene.breathMs, phase), blinks.variants[index]);
    });
    return { files, blinkState: blinks.state, untilMs };
}
