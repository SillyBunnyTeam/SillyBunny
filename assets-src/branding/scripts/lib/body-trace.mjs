import { splitSubpaths } from './geometry.mjs';
import { DOME_DEGREE, findCrease, fitDomeSides, healDomeSides } from './dome-edge.mjs';
import { lumaOf, silhouetteCoverage, toneLumaField, traceTones } from './field-trace.mjs';
import { boundaryDeviation, orientOutlines } from './outline-fit.mjs';
import { findHoles } from './pixel-draft.mjs';
import { rasterFromTones } from './line-shading.mjs';

// The dome's sides are redrawn from a few rows under the notch where the ear meets them to a little below where the dome's bottom band starts.
const CREASE_MARGIN = 6;
const BELOW_BASE_ROW = 20;
// How far from the dome the search for its edge goes on each side, so that a dot or a charm beside it is not taken for the edge.
const SEARCH_REACH = 30;
// An edge that has to move further than this to meet its curve is not a step from a line, so the run stops.
export const MAX_EDGE_MOVE = 8;

/**
 * The ears and the dome as path commands for each tone, from a picture with the lines and dots already taken out:
 * 1. each side of the dome is redrawn on one smooth curve, where the lines left steps;
 * 2. the shape, its two bands and the letters are traced with potrace from fields at the same scale, so a band ends on the shape's edge,
 *    and the letters are holes in the base layer with the same sub-pixel edge as the rest.
 * @param {{ index: Int8Array, source: import('./raster.mjs').Raster, tones: { hex: string, rgb: number[] }[], roles: { base: number, dark: number, light: number }, base: { centreX: number, left: number, right: number, row: number }, potrace: string, directory: string }} request
 * `index` is the tone of each pixel (negative for none) with the lines taken out; `source` is the master, whose alpha and colours give the edges
 * @returns {Promise<{ layers: { fill: string, commands: import('./geometry.mjs').PathCommand[] }[], index: Int8Array, raster: import('./raster.mjs').Raster, curves: { left: import('./dome-edge.mjs').EdgeCurve, right: import('./dome-edge.mjs').EdgeCurve }, outsideClockwise: boolean, dome: object, letters: object }>}
 */
export async function traceBody({ index, source, tones, roles, base, potrace, directory }) {
    const { width, height } = source;
    const centre = Math.round(base.centreX);
    const search = { left: [Math.max(0, base.left - SEARCH_REACH), centre], right: [centre, Math.min(width, base.right + SEARCH_REACH)] };
    const creases = ['left', 'right'].map((side) => findCrease({ index, width, from: base.row - 250, to: base.row, side, search: side === 'left' ? [0, centre] : [centre, width] }));
    const [from, to] = [Math.max(...creases) + CREASE_MARGIN, base.row + BELOW_BASE_ROW];
    const sides = fitDomeSides({ index, width, from, to, search, degree: DOME_DEGREE });
    const curves = { left: sides.left.curve, right: sides.right.curve };
    const healed = healDomeSides({ index, width, from, to, search, curves });
    if (healed.farthest > MAX_EDGE_MOVE) {
        throw new Error(`The dome's edge had to move ${healed.farthest} pixels on row ${healed.farthestRow} to meet its curve, more than ${MAX_EDGE_MOVE}; nothing was written.`);
    }

    const raster = rasterFromTones(healed.index, width, height, tones);
    const holes = findHoles(raster);
    const alpha = Uint8Array.from({ length: width * height }, (_, at) => source.data[at * 4 + 3]);
    const coverage = silhouetteCoverage({ alpha, body: Uint8Array.from(healed.index, (tone) => (tone >= 0 ? 1 : 0)), width, height, curves, rows: [from, to] });
    const lumas = tones.map(({ rgb }) => lumaOf(...rgb));
    const luma = toneLumaField({ rgba: source.data, width, height, index: healed.index, original: index, lumas, fallback: roles.base });
    const traced = await traceTones({ coverage, luma, width, height, levels: { dark: lumas[roles.dark], base: lumas[roles.base], light: lumas[roles.light] } }, { potrace, directory });
    // Every outline runs clockwise on the outside and the other way for a hole, so the lines can be drawn to match. The letters are holes in the
    // base layer, so they run the other way round from its outside, and a counter inside a letter the same way as the outside.
    const layers = [
        { fill: tones[roles.base].hex, commands: [...orientOutlines(traced.base, true), ...orientOutlines(traced.letters, false)] },
        { fill: tones[roles.dark].hex, commands: orientOutlines(traced.dark, true) },
        { fill: tones[roles.light].hex, commands: orientOutlines(traced.light, true) },
    ];

    const letterOutlines = splitSubpaths(traced.letters);
    return {
        layers,
        index: healed.index,
        raster,
        curves,
        outsideClockwise: true,
        dome: {
            rows: [from, to],
            creases,
            left: { rows: sides.left.rows, used: sides.left.used.length, maxResidual: sides.left.maxResidual, rms: sides.left.rms },
            right: { rows: sides.right.rows, used: sides.right.used.length, maxResidual: sides.right.maxResidual, rms: sides.right.rms },
            changed: healed.changed,
            farthest: healed.farthest,
            farthestRow: healed.farthestRow,
        },
        letters: { subpaths: letterOutlines.length, deviation: boundaryDeviation(traced.letters, holes, width, height), holePixels: holes.reduce((sum, value) => sum + value, 0) },
    };
}
