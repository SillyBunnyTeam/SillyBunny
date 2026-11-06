import { dilateMask } from '../scripts/lib/shape-ops.mjs';
import { ellipse, rect } from './emblem.mjs';
import { createRaster } from './synthetic.mjs';

export const RIM = [185, 155, 242];
export const BAND = [255, 255, 255];
export const DRESS = [40, 40, 70];
export const EAR = [250, 245, 240];
const SKIN = [240, 200, 170];

/**
 * A waist-up sprite on a transparent canvas, drawn the way the card art is: a head with two tall ears that stand out to the sides of it, a
 * body that is cut flat at `cutRow`, and a white band and a lavender rim `stickerWidth` pixels wide each round the whole outline,
 * including under the waist cut, where they run across as a white and a lavender line. The ears are the widest part of the sprite, so
 * a card that cut a side would cut an ear.
 */
export function waistSprite({ width = 400, height = 600, cutRow = 520, stickerWidth = 8, earReach = 30 } = {}) {
    const raster = createRaster(width, height);
    const solid = new Uint8Array(width * height);
    const centre = width / 2;
    const paint = (inside, colour) => {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (inside(x + 0.5, y + 0.5)) {
                    raster.data.set([...colour, 255], (y * width + x) * 4);
                    solid[y * width + x] = 1;
                }
            }
        }
    };
    paint(ellipse(earReach + 18, 140, 18, 100), EAR);
    paint(ellipse(width - earReach - 18, 140, 18, 100), EAR);
    paint(ellipse(centre, 210, 80, 90), SKIN);
    paint(rect(centre - 140, 290, centre + 140, cutRow), DRESS);
    const inner = dilateMask(solid, width, height, stickerWidth);
    const outer = dilateMask(solid, width, height, stickerWidth * 2);
    for (let at = 0; at < solid.length; at++) {
        if (solid[at] === 0 && inner[at] === 1) {
            raster.data.set([...BAND, 255], at * 4);
        } else if (solid[at] === 0 && outer[at] === 1) {
            raster.data.set([...RIM, 255], at * 4);
        }
    }
    return raster;
}
