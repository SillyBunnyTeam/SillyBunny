import { opaqueBox } from './raster.mjs';
import { measureFigureScaled } from './scene-measure.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */

/** The ratios of Tewi's head-to-feet over Reisen's that are let through: the line-up that snap-config.json sets, give or take a little. */
export const LINEUP_RANGE = Object.freeze({ min: 0.81, max: 0.85 });
/** The middle share of a scene's width in which the two figures meet, and so where the gap between them is looked for. */
const MEETING = { from: 0.3, to: 0.7 };

/**
 * The column where the two figures part: the one with the fewest drawn pixels inside the middle of the picture's drawn box. When the
 * figures overlap there is no empty column, and the thinnest one is the best guess for where one ends and the other begins.
 * @param {Raster} native
 */
export function findSplitColumn(native) {
    const box = opaqueBox(native);
    const counts = Array.from({ length: native.width }, (_, x) => {
        let drawn = 0;
        for (let y = 0; y < native.height; y++) {
            drawn += native.data[(y * native.width + x) * 4 + 3] === 0 ? 0 : 1;
        }
        return drawn;
    });
    const first = Math.floor(box.x + box.width * MEETING.from);
    const last = Math.ceil(box.x + box.width * MEETING.to);
    let best = first;
    for (let x = first; x <= last; x++) {
        best = counts[x] < counts[best] ? x : best;
    }
    return best;
}

/**
 * How tall each figure of a snapped scene is, head top to feet with the ears left out, and Tewi's over Reisen's.
 * `pose` says whether the two are comparable: when both stand, or both sit, their head-to-feet heights compare as the line-up does; when
 * one kneels and the other stands, the ratio is only reported.
 * @param {Raster} native
 * @param {{ reisen: 'left' | 'right', pose: 'standing' | 'seated' | 'mixed' }} scene
 * @returns {{ reisen: number, tewi: number, ratio: number, split: number, comparable: boolean, verdict: 'ok' | 'check' | 'not comparable' }}
 */
export function measureLineup(native, { reisen: side, pose }) {
    const split = findSplitColumn(native);
    const left = measureFigureScaled(native, { xRange: [0, split] });
    const right = measureFigureScaled(native, { xRange: [split + 1, native.width - 1] });
    const [reisenFigure, tewiFigure] = side === 'left' ? [left, right] : [right, left];
    const ratio = tewiFigure.figureHeight / reisenFigure.figureHeight;
    const comparable = pose !== 'mixed';
    const inRange = ratio >= LINEUP_RANGE.min && ratio <= LINEUP_RANGE.max;
    return { reisen: reisenFigure.figureHeight, tewi: tewiFigure.figureHeight, ratio, split, comparable, verdict: !comparable ? 'not comparable' : inRange ? 'ok' : 'check' };
}
