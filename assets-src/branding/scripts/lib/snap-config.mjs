import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_KEYS = new Set(['bodyHeights', 'lineupRatio', 'rings']);
// The two heights may differ from the line-up ratio by this much (a share of it) before the config is called inconsistent: the heights are whole pixels.
const RATIO_TOLERANCE = 0.005;

/**
 * Parses snap-config.json: `{ bodyHeights: { "<character>": art pixels }, lineupRatio }`. A body height is head top to feet, ears left out, in
 * art pixels, so a character is snapped at one pixel size whichever picture she is in. `lineupRatio` is Tewi's height over Reisen's; the file
 * is refused when the two heights drift from it, so one cannot be edited without the other.
 * @param {any} raw
 * `rings` (optional) sets the rim and band width of every snapped picture, so one sticker width is drawn everywhere.
 * @returns {{ bodyHeights: Record<string, number>, lineupRatio: number, rings?: { rim: number, band: number } }}
 */
export function parseSnapConfig(raw) {
    for (const key of Object.keys(raw ?? {})) {
        if (!CONFIG_KEYS.has(key)) {
            throw new Error(`snap-config.json: unknown key "${key}". Known keys: ${[...CONFIG_KEYS].join(', ')}.`);
        }
    }
    const heights = Object.entries(raw?.bodyHeights ?? {});
    if (heights.length === 0) {
        throw new Error('snap-config.json: bodyHeights needs at least one character.');
    }
    for (const [character, height] of heights) {
        if (!Number.isInteger(height) || height < 8) {
            throw new Error(`snap-config.json: the body height of "${character}" must be a whole number of 8 or more art pixels, got ${JSON.stringify(height)}.`);
        }
    }
    const bodyHeights = Object.fromEntries(heights);
    const { lineupRatio } = raw;
    if (!(typeof lineupRatio === 'number' && lineupRatio > 0 && lineupRatio < 1)) {
        throw new Error('snap-config.json: lineupRatio must be Tewi\'s height over Reisen\'s, a number between 0 and 1.');
    }
    if (bodyHeights.tewi !== undefined && bodyHeights.reisen !== undefined) {
        const actual = bodyHeights.tewi / bodyHeights.reisen;
        if (Math.abs(actual - lineupRatio) / lineupRatio > RATIO_TOLERANCE) {
            throw new Error(`snap-config.json: tewi ${bodyHeights.tewi} over reisen ${bodyHeights.reisen} is ${actual.toFixed(4)}, not the line-up ratio ${lineupRatio}. reisen should be ${Math.round(bodyHeights.tewi / lineupRatio)}.`);
        }
    }
    return { bodyHeights, lineupRatio, rings: parseRings(raw.rings) };
}

/** `rings: { rim, band }`, the widths in art pixels of the sticker's lavender rim and white band on every snapped picture. */
function parseRings(raw) {
    if (raw === undefined) {
        return undefined;
    }
    for (const key of Object.keys(raw ?? {})) {
        if (key !== 'rim' && key !== 'band') {
            throw new Error(`snap-config.json: rings has an unknown key "${key}". It takes rim and band.`);
        }
    }
    for (const name of ['rim', 'band']) {
        if (!Number.isInteger(raw?.[name]) || raw[name] < 1) {
            throw new Error(`snap-config.json: rings.${name} must be a whole number of 1 or more art pixels, got ${JSON.stringify(raw?.[name])}.`);
        }
    }
    return { rim: raw.rim, band: raw.band };
}

export function readSnapConfig(rootDir) {
    const path = join(rootDir, 'snap-config.json');
    if (!existsSync(path)) {
        throw new Error('snap-config.json does not exist, so the body height of a character is unknown. Pass --body-height, --figure-height, --cell or --detect.');
    }
    return parseSnapConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * The character a picture shows: from `characters` in prompts/s5-masters.json under the picture's id, unless the caller names one.
 * A picture of both characters has none, because a scene is built from one snapped still per character.
 * @param {string} rootDir
 * @param {string} id
 * @param {string} [named]
 */
export function characterOf(rootDir, id, named) {
    if (named !== undefined) {
        return named;
    }
    const path = join(rootDir, 'prompts', 's5-masters.json');
    const asset = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).assets?.[id] : undefined;
    if (!asset) {
        throw new Error(`"${id}" is not in prompts/s5-masters.json, so its character is unknown. Pass --character <name>, or --body-height, --figure-height, --cell or --detect.`);
    }
    if (asset.characters.length !== 1) {
        throw new Error(`"${id}" shows ${asset.characters.join(' and ')}, so it has no one body height. A scene is built from one snapped still per character: snap each layer's still (see snap-batch.json), or pass --body-height.`);
    }
    return asset.characters[0];
}

/** The body height set for the picture's character. */
export function bodyHeightFor({ rootDir, id, character }) {
    const name = characterOf(rootDir, id, character);
    const { bodyHeights } = readSnapConfig(rootDir);
    if (bodyHeights[name] === undefined) {
        throw new Error(`snap-config.json has no body height for "${name}". It has: ${Object.keys(bodyHeights).join(', ')}.`);
    }
    return { character: name, bodyHeight: bodyHeights[name] };
}

/** The ring widths snap-config.json sets, as snapRaster takes them, or none when there is no config or it sets none. */
export function configuredRingWidths(rootDir) {
    const path = join(rootDir, 'snap-config.json');
    const rings = existsSync(path) ? readSnapConfig(rootDir).rings : undefined;
    return rings ? { rimWidth: rings.rim, bandWidth: rings.band } : {};
}
