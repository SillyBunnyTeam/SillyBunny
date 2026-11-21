import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS } from './frame-mask.mjs';

export const SPLASH_CONFIG_FILE = 'splash-config.json';

const NAME = /^[\w-]+$/;
const BASE_KEYS = ['id', 'file', 'character', 'pose', 'options'];
const FRAME_KEYS = ['name', 'base', 'edit', 'keep', 'settings'];
const SCENE_KEYS = ['id', 'left', 'right', 'gap', 'margin'];
const TIMELINE_KEYS = ['seconds', 'keys', 'effect'];
const BOTH_KEYS = ['seconds', 'reisen', 'tewi'];

const fail = (message) => {
    throw new Error(`${SPLASH_CONFIG_FILE}: ${message}`);
};

const only = (value, keys, where) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${where} must be an object.`);
    }
    for (const key of Object.keys(value)) {
        if (!keys.includes(key)) {
            fail(`${where} has an unknown key "${key}". Known keys: ${keys.join(', ')}.`);
        }
    }
    return value;
};

const nameOf = (value, where) => {
    if (typeof value !== 'string' || !NAME.test(value)) {
        fail(`${where} must be a name of letters, digits, "_" and "-", got ${JSON.stringify(value)}.`);
    }
    return value;
};

const pathOf = (value, where) => {
    if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.split('/').includes('..')) {
        fail(`${where} must be a path inside the package, got ${JSON.stringify(value)}.`);
    }
    return value;
};

const parseBox = (raw, where) => {
    const box = only(raw, ['x', 'y', 'width', 'height'], where);
    if (!['x', 'y'].every((key) => Number.isInteger(box[key]) && box[key] >= 0) || !['width', 'height'].every((key) => Number.isInteger(box[key]) && box[key] >= 1)) {
        fail(`${where} needs whole master pixels: x and y from 0, width and height from 1.`);
    }
    return { x: box.x, y: box.y, width: box.width, height: box.height };
};

const WHOLE_SETTINGS = ['shift', 'openRadius', 'closeRadius'];
const ALPHA_MAX = 255;

function parseSettings(raw, where) {
    const settings = only(raw ?? {}, Object.keys(DEFAULTS), where);
    for (const [key, value] of Object.entries(settings)) {
        if (!(Number.isFinite(value) && value >= 0)) {
            fail(`${where}.${key} must be a number of 0 or more, got ${JSON.stringify(value)}.`);
        }
        if (WHOLE_SETTINGS.includes(key) && !Number.isInteger(value)) {
            fail(`${where}.${key} must be a whole number of pixels, got ${JSON.stringify(value)}.`);
        }
        if (key === 'minAlpha' && value > ALPHA_MAX) {
            fail(`${where}.minAlpha must be at most ${ALPHA_MAX}, got ${JSON.stringify(value)}.`);
        }
    }
    return { ...settings };
}

function parseKeys(raw, where, poses, seconds) {
    if (!Array.isArray(raw) || raw.length === 0) {
        fail(`${where} needs at least one key.`);
    }
    const keys = raw.map((key, index) => {
        const entry = only(key, ['at', 'frame'], `${where}[${index}]`);
        if (!(Number.isFinite(entry.at) && entry.at >= 0 && entry.at < seconds)) {
            fail(`${where}[${index}].at must be a time from 0 up to (not including) ${seconds} seconds, got ${JSON.stringify(entry.at)}.`);
        }
        if (!poses.includes(entry.frame)) {
            fail(`${where}[${index}].frame "${entry.frame}" is not a pose of this character. Poses: ${poses.join(', ')}.`);
        }
        return { at: entry.at, frame: entry.frame };
    });
    if (keys[0].at !== 0 || keys.some((key, index) => index > 0 && key.at <= keys[index - 1].at)) {
        fail(`${where} must start at 0 and go forward in time.`);
    }
    return keys;
}

const secondsOf = (value, where) => {
    if (!(Number.isFinite(value) && value > 0)) {
        fail(`${where} must be a number of seconds above 0, got ${JSON.stringify(value)}.`);
    }
    return value;
};

/**
 * Parses splash-config.json: the two `bases` (a smooth picture each, its snap id, character and the name of its pose), the `frames` made from them
 * (each a base and an edit of it, with the parts that must stay the base's as `keep` boxes named in `keep` by character, and the `settings` of
 * the mask), the grid `scene` that holds both characters, and the `timelines` the preview plays (one for each character, and one for both).
 * @param {any} raw
 */
export function parseSplashConfig(raw) {
    only(raw, ['bases', 'keep', 'frames', 'scene', 'timelines'], 'the file');
    const baseNames = Object.keys(only(raw.bases, ['reisen', 'tewi'], 'bases'));
    if (baseNames.length !== 2) {
        fail('bases needs "reisen" and "tewi".');
    }
    const bases = Object.fromEntries(baseNames.map((key) => {
        const base = only(raw.bases[key], BASE_KEYS, `bases.${key}`);
        return [key, { id: nameOf(base.id, `bases.${key}.id`), file: pathOf(base.file, `bases.${key}.file`), character: nameOf(base.character, `bases.${key}.character`), pose: nameOf(base.pose, `bases.${key}.pose`), options: base.options ?? {} }];
    }));
    const keep = Object.fromEntries(Object.entries(raw.keep ?? {}).map(([group, list]) => {
        if (!Array.isArray(list)) {
            fail(`keep.${group} must be a list of boxes.`);
        }
        return [group, list.map((item, index) => ({ name: nameOf(item?.name, `keep.${group}[${index}].name`), box: parseBox(item?.box, `keep.${group}[${index}].box`) }))];
    }));
    if (!Array.isArray(raw.frames) || raw.frames.length === 0) {
        fail('frames needs at least one frame.');
    }
    const frames = raw.frames.map((item, index) => {
        const frame = only(item, FRAME_KEYS, `frames[${index}]`);
        const base = nameOf(frame.base, `frames[${index}].base`);
        if (!bases[base]) {
            fail(`frames[${index}].base "${base}" is not one of the bases (${baseNames.join(', ')}).`);
        }
        if (frame.keep !== undefined && !keep[frame.keep]) {
            fail(`frames[${index}].keep "${frame.keep}" is not a group in keep.`);
        }
        return { name: nameOf(frame.name, `frames[${index}].name`), base, edit: pathOf(frame.edit, `frames[${index}].edit`), keep: frame.keep === undefined ? [] : keep[frame.keep], settings: parseSettings(frame.settings, `frames[${index}].settings`) };
    });
    const poses = Object.fromEntries(baseNames.map((key) => [key, [bases[key].pose, ...frames.filter(({ base }) => base === key).map(({ name }) => name)]]));
    for (const [key, list] of Object.entries(poses)) {
        if (new Set(list).size !== list.length) {
            fail(`the poses of ${key} are not all different: ${list.join(', ')}.`);
        }
    }
    const scene = only(raw.scene, SCENE_KEYS, 'scene');
    if (!['left', 'right'].every((side) => baseNames.includes(scene[side])) || scene.left === scene.right) {
        fail('scene.left and scene.right must be the two different bases.');
    }
    if (!(Number.isInteger(scene.gap) && scene.gap >= 0 && Number.isInteger(scene.margin) && scene.margin >= 0)) {
        fail('scene.gap and scene.margin must be whole numbers of art pixels, 0 or more.');
    }
    const timelines = only(raw.timelines, ['reisen', 'tewi', 'both'], 'timelines');
    const parsed = {};
    for (const key of baseNames) {
        const line = only(timelines[key], TIMELINE_KEYS, `timelines.${key}`);
        const seconds = secondsOf(line.seconds, `timelines.${key}.seconds`);
        const effect = only(line.effect, ['frame', 'at'], `timelines.${key}.effect`);
        if (!poses[key].includes(effect.frame)) {
            fail(`timelines.${key}.effect.frame "${effect.frame}" is not a pose of ${key}.`);
        }
        const at = only(effect.at, ['x', 'y'], `timelines.${key}.effect.at`);
        if (![at.x, at.y].every((share) => Number.isFinite(share) && share >= 0 && share <= 1)) {
            fail(`timelines.${key}.effect.at must give x and y as shares of the layer's width and height, from 0 to 1.`);
        }
        parsed[key] = { seconds, keys: parseKeys(line.keys, `timelines.${key}.keys`, poses[key], seconds), effect: { frame: effect.frame, at: { x: at.x, y: at.y } } };
    }
    const both = only(timelines.both, BOTH_KEYS, 'timelines.both');
    const bothSeconds = secondsOf(both.seconds, 'timelines.both.seconds');
    parsed.both = { seconds: bothSeconds, ...Object.fromEntries(baseNames.map((key) => [key, parseKeys(both[key], `timelines.both.${key}`, poses[key], bothSeconds)])) };
    return { bases, frames, scene: { id: nameOf(scene.id, 'scene.id'), left: scene.left, right: scene.right, gap: scene.gap, margin: scene.margin }, timelines: parsed, poses };
}

/** Reads and parses splash-config.json from the package root. */
export function loadSplashConfig(rootDir) {
    const path = join(rootDir, SPLASH_CONFIG_FILE);
    if (!existsSync(path)) {
        throw new Error(`${path} does not exist.`);
    }
    return parseSplashConfig(JSON.parse(readFileSync(path, 'utf8')));
}
