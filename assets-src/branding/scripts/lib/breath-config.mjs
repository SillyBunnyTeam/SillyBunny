import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BREATH_CONFIG_FILE = 'breath-config.json';

const KEYS = ['waist', 'cycleSeconds', 'breathsPerCycle', 'stills', 'scenes'];

const fail = (message) => {
    throw new Error(`${BREATH_CONFIG_FILE}: ${message}`);
};

const names = (value, where) => {
    if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !/^[\w-]+$/.test(name))) {
        fail(`${where} must be a list of picture names such as "hero-duo".`);
    }
    if (new Set(value).size !== value.length) {
        fail(`${where} names a picture twice.`);
    }
    return value;
};

/**
 * Parses breath-config.json: `waist`, the share of the way from the head top to the feet (measured on the opaque box) at which the rows stop
 * moving; `cycleSeconds` and `breathsPerCycle`, the rhythm the preview and the layout file report (each breath is a neutral pose and a pose one row
 * down, held for the same time); and the `stills` and `scenes` a run with no names makes.
 * @param {any} raw
 * @returns {{ waist: number, cycleSeconds: number, breathsPerCycle: number, stills: string[], scenes: string[] }}
 */
export function parseBreathConfig(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        fail('the file must hold an object.');
    }
    for (const key of Object.keys(raw)) {
        if (!KEYS.includes(key)) {
            fail(`unknown key "${key}". Known keys: ${KEYS.join(', ')}.`);
        }
    }
    if (!(typeof raw.waist === 'number' && raw.waist > 0 && raw.waist < 1)) {
        fail(`waist must be a number above 0 and below 1, got ${JSON.stringify(raw.waist)}.`);
    }
    if (!(typeof raw.cycleSeconds === 'number' && raw.cycleSeconds > 0)) {
        fail(`cycleSeconds must be a number of seconds above 0, got ${JSON.stringify(raw.cycleSeconds)}.`);
    }
    if (!Number.isInteger(raw.breathsPerCycle) || raw.breathsPerCycle < 1) {
        fail(`breathsPerCycle must be a whole number of 1 or more, got ${JSON.stringify(raw.breathsPerCycle)}.`);
    }
    return { waist: raw.waist, cycleSeconds: raw.cycleSeconds, breathsPerCycle: raw.breathsPerCycle, stills: names(raw.stills, 'stills'), scenes: names(raw.scenes, 'scenes') };
}

/** Reads and parses breath-config.json from the package root. */
export function loadBreathConfig(rootDir) {
    const path = join(rootDir, BREATH_CONFIG_FILE);
    if (!existsSync(path)) {
        throw new Error(`${path} does not exist.`);
    }
    return parseBreathConfig(JSON.parse(readFileSync(path, 'utf8')));
}
