#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The content width of a settings page follows libadwaita's AdwClamp (libadwaita 1.10, src/adw-clamp-layout.c,
 * `child_size_from_clamp`). For an available width `w`, with `lower` the tightening threshold and `max` the maximum:
 *
 *   upper = lower + 3 * (max - lower)
 *   w <= lower: w.   w >= upper: max.
 *   otherwise p = (w - lower) / (upper - lower) and content = lower + (1 - (1 - p)^3) * (max - lower).
 *
 * CSS cannot divide one length by another or raise to a power, so the curve is replaced by chords. The curve is concave, so
 * the polygon through points on it is the `min()` of its chord lines. Each line is `lower * a + max * b + slope * w`; with the
 * threshold a fixed share of the maximum, `lower` is replaced by `ratio * max` and each line has two numbers: one for the
 * maximum and one for the available width. The polygon lies under the curve, so a page is never wider than AdwClamp makes it.
 *
 * `node scripts/generate-clamp-curve.js` writes the result between the `clamp-curve` markers of the settings stylesheet, and
 * `--check` exits with 1 when the stylesheet differs. Change the settings below and run it again.
 */

export const STYLESHEET = 'public/css/sillybunny-tabs.css';
export const BEGIN_MARKER = '/* clamp-curve:begin (written by scripts/generate-clamp-curve.js; do not edit by hand) */';
export const END_MARKER = '/* clamp-curve:end */';

/** The tightening threshold is two thirds of the maximum. The fraction stays exact in the formulas below. */
export const THRESHOLD_RATIO = Object.freeze({ numerator: 2, denominator: 3 });
/** Chords of the curve. The unit test holds the error of eight under 3px for both maximums of the settings page. */
export const SEGMENTS = 8;
/** `upper = lower + EASE_OUT_TAN_CUBIC * (max - lower)`: libadwaita's ADW_EASE_OUT_TAN_CUBIC. */
export const EASE_OUT_TAN_CUBIC = 3;

const easeOutCubic = progress => 1 - (1 - progress) ** 3;

/**
 * The curve for an available width (px), without the integer rounding of the C code and with no minimum size of the child.
 * @param {number} available
 * @param {number} max
 * @param {number} threshold
 */
export function exactClamp(available, max, threshold) {
    const lower = Math.min(threshold, max);
    const upper = lower + EASE_OUT_TAN_CUBIC * (Math.max(lower, max) - lower);
    if (available <= lower) return available;
    if (available >= upper) return Math.max(lower, max);
    const progress = (available - lower) / (upper - lower);
    return lower + easeOutCubic(progress) * (Math.max(lower, max) - lower);
}

/**
 * The chord lines of the curve for a threshold of `ratio` times the maximum, as `max * maxPart + available * slope`.
 * The knots are `p = 1 - (1 - k / SEGMENTS)^(2/3)`: the curvature of the curve is `2 * (1 - p)`, so equal steps of
 * `(1 - p)^(3/2)` give every chord the same error. Evenly spaced knots leave the first chord with the most.
 * @param {{ segments?: number, ratio?: number }} [options]
 * @returns {{ slope: number, maxPart: number }[]}
 */
export function chordLines({ segments = SEGMENTS, ratio = THRESHOLD_RATIO.numerator / THRESHOLD_RATIO.denominator } = {}) {
    const knots = Array.from({ length: segments + 1 }, (_, index) => 1 - (1 - index / segments) ** (2 / 3));
    return knots.slice(0, -1).map((start, index) => {
        const end = knots[index + 1];
        const slope = (easeOutCubic(end) - easeOutCubic(start)) / (EASE_OUT_TAN_CUBIC * (end - start));
        const maxCoefficient = easeOutCubic(start) - EASE_OUT_TAN_CUBIC * slope * start;
        const lowerCoefficient = 1 - slope - maxCoefficient;
        return { slope, maxPart: lowerCoefficient * ratio + maxCoefficient };
    });
}

/** The width the chords give, in px, for a maximum and an available width. */
export function chordClamp(available, max, lines = chordLines()) {
    return lines.reduce((width, { slope, maxPart }) => Math.min(width, maxPart * max + slope * available), Math.min(available, max));
}

const trimmed = value => String(Number(value.toFixed(6)));

/**
 * The declaration of the stylesheet. `--sb-page-available` is the width the page fills (its box less both insets) and
 * `--sb-page-max` its maximum; both are set on the element that pads the page, so the percentage in the first resolves there.
 * @param {{ slope: number, maxPart: number }[]} [lines]
 */
export function renderDeclaration(lines = chordLines()) {
    const terms = [
        'var(--sb-page-available)',
        ...lines.map(({ slope, maxPart }) => `calc(${trimmed(maxPart)} * var(--sb-page-max) + ${trimmed(slope)} * var(--sb-page-available))`),
        'var(--sb-page-max)',
    ];
    return `--sb-page-content: min(\n${terms.map(term => `        ${term}`).join(',\n')}\n    );`;
}

/**
 * The stylesheet with the text between the markers replaced.
 * @param {string} css
 * @param {string} [declaration]
 */
export function updateStylesheet(css, declaration = renderDeclaration()) {
    const begin = css.indexOf(BEGIN_MARKER);
    const end = css.indexOf(END_MARKER);
    if (begin < 0 || end < begin) {
        throw new Error(`${STYLESHEET} has no ${BEGIN_MARKER} and ${END_MARKER} pair.`);
    }
    return `${css.slice(0, begin + BEGIN_MARKER.length)}\n    ${declaration}\n    ${css.slice(end)}`;
}

/**
 * @param {{ check?: boolean, root?: string }} [options]
 * @returns {{ changed: boolean, file: string }}
 */
export function run({ check = false, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
    const file = path.join(root, STYLESHEET);
    const current = fs.readFileSync(file, 'utf8');
    const next = updateStylesheet(current);
    const changed = next !== current;
    if (changed && !check) fs.writeFileSync(file, next);
    return { changed, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    const { changed, file } = run({ check });
    if (check && changed) {
        console.error(`${path.relative(process.cwd(), file)} is out of date. Run: node scripts/generate-clamp-curve.js`);
        process.exit(1);
    }
    console.log(changed ? `Wrote the clamp curve to ${path.relative(process.cwd(), file)}.` : 'The clamp curve is up to date.');
}
