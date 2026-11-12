import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const toLinear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const toGamma = (linear) => 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);

/** @param {number[]} rgb 0-255 */
export function srgbToOklab([red, green, blue]) {
    const r = toLinear(red);
    const g = toLinear(green);
    const b = toLinear(blue);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

/** Returns unclamped 0-255 floats, so a caller can test for gamut before rounding. */
export function oklabToLinear([lightness, a, b]) {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
}

/** @returns {number[]} 0-255 floats, not clamped */
export const oklabToSrgb = (lab) => oklabToLinear(lab).map((linear) => toGamma(Math.min(Math.max(linear, 0), 1)) * 1 + (linear < 0 || linear > 1 ? 0 : 0));

export const formatHex = (rgb) => `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

const HEX_LINE = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const GPL_LINE = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s.*)?$/;

/**
 * Reads a palette from .hex (one colour per line) or GIMP .gpl text. The format is told apart by the first line.
 * A duplicate colour is an error, because a locked palette with repeats hides a colour count that is too high.
 * @param {string} text
 * @param {string} source file name used in error messages
 * @returns {number[][]}
 */
export function parsePalette(text, source) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const isGpl = lines[0].trim() === 'GIMP Palette';
    const colours = [];
    for (const [index, raw] of lines.entries()) {
        const line = raw.trim();
        const isHeader = isGpl && (index === 0 || line.startsWith('#') || /^(Name|Columns):/.test(line));
        if (!line || isHeader) {
            continue;
        }
        const parts = isGpl ? GPL_LINE.exec(line)?.slice(1, 4).map(Number) : HEX_LINE.exec(line)?.slice(1, 4).map((hex) => Number.parseInt(hex, 16));
        if (!parts || parts.some((channel) => channel > 255)) {
            throw new Error(`${source} line ${index + 1}: cannot read "${line}" as a colour.`);
        }
        if (colours.some((known) => known.every((channel, at) => channel === parts[at]))) {
            throw new Error(`${source}: duplicate colour ${formatHex(parts)}.`);
        }
        colours.push(parts);
    }
    if (colours.length === 0) {
        throw new Error(`${source} has no colours.`);
    }
    return colours;
}

/** Looks in the working directory first, then in palettes/ of the package; .hex and .gpl are both tried. */
export function findPalettePath(rootDir, name) {
    const bases = [resolve(name), ...(isAbsolute(name) ? [] : [join(rootDir, name), join(rootDir, 'palettes', name)])];
    for (const base of bases) {
        for (const suffix of ['', '.hex', '.gpl']) {
            if (/\.(hex|gpl)$/.test(base + suffix) && existsSync(base + suffix)) {
                return base + suffix;
            }
        }
    }
    throw new Error(`No palette "${name}" (tried ${name}, ${name}.hex, ${name}.gpl and palettes/${name}.hex or .gpl).`);
}

export const readPalette = (path) => parsePalette(readFileSync(path, 'utf8'), path);

/**
 * Nearest palette entry in OKLab, which tracks perceived difference better than RGB distance.
 * Results are cached per source colour because a large image repeats few distinct colours.
 * @param {number[][]} palette
 */
export function paletteIndexFinder(palette) {
    const labs = palette.map(srgbToOklab);
    const cache = new Map();
    return (r, g, b) => {
        const key = (r << 16) | (g << 8) | b;
        const known = cache.get(key);
        if (known !== undefined) {
            return known;
        }
        const [lightness, a, bb] = srgbToOklab([r, g, b]);
        let best = 0;
        let bestDistance = Infinity;
        for (const [index, lab] of labs.entries()) {
            const distance = (lab[0] - lightness) ** 2 + (lab[1] - a) ** 2 + (lab[2] - bb) ** 2;
            if (distance < bestDistance) {
                best = index;
                bestDistance = distance;
            }
        }
        cache.set(key, best);
        return best;
    };
}
