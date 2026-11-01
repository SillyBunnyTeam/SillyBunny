import { dilateMask } from '../scripts/lib/shape-ops.mjs';
import { createRaster } from './synthetic.mjs';
import { ellipse, rect } from './emblem.mjs';

export const HAIR = [180, 160, 230];
const FUR = [252, 250, 252];
const INNER_EAR = [235, 140, 150];
const SKIN = [250, 215, 190];
const DRESS = [120, 150, 220];
const OUTLINE = [255, 255, 255];
const RIM = [185, 155, 242];
export const STICKER = 6;

/**
 * A standing sticker figure on a transparent canvas: tall white ears with pink insides that rise above a lavender head, one thin
 * strand of hair above the head, a body, legs and feet, and a white outline and lavender rim around the whole silhouette.
 * `sticker` is the width of each of the two rings in pixels. The head's top is at y = 100 and the feet are at y = 460 before the sticker adds STICKER * 2 around it.
 */
export function figure({ width = 300, height = 520, shiftX = 0, sticker = STICKER } = {}) {
    const raster = createRaster(width, height);
    const solid = new Uint8Array(width * height);
    const paint = (inside, colour) => {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (inside(x + 0.5 - shiftX, y + 0.5)) {
                    raster.data.set([...colour, 255], (y * width + x) * 4);
                    solid[y * width + x] = 1;
                }
            }
        }
    };
    paint(ellipse(120, 75, 14, 55), FUR);
    paint(ellipse(120, 85, 7, 35), INNER_EAR);
    paint(ellipse(180, 75, 14, 55), FUR);
    paint(ellipse(180, 85, 7, 35), INNER_EAR);
    paint(rect(148, 80, 152, 105), HAIR);
    paint(ellipse(150, 150, 50, 50), HAIR);
    paint(ellipse(150, 160, 28, 30), SKIN);
    paint(rect(110, 195, 190, 380), DRESS);
    paint(rect(125, 380, 145, 460), SKIN);
    paint(rect(155, 380, 175, 460), SKIN);
    const outer = dilateMask(solid, width, height, sticker * 2);
    const inner = dilateMask(solid, width, height, sticker);
    for (let at = 0; at < solid.length; at++) {
        if (solid[at] === 0 && inner[at] === 1) {
            raster.data.set([...OUTLINE, 255], at * 4);
        } else if (solid[at] === 0 && outer[at] === 1) {
            raster.data.set([...RIM, 255], at * 4);
        }
    }
    return raster;
}
