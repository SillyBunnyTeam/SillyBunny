import { createRaster } from './synthetic.mjs';

export const MID = [139, 100, 170];
export const DARK = [89, 60, 103];
export const LIGHT = [171, 139, 187];
export const SIZE = 400;

function fill(raster, inside, colour) {
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            if (inside(x + 0.5, y + 0.5)) {
                raster.data.set([...colour, 255], (y * raster.width + x) * 4);
            }
        }
    }
}

function clear(raster, inside) {
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            if (inside(x + 0.5, y + 0.5)) {
                raster.data.set([0, 0, 0, 0], (y * raster.width + x) * 4);
            }
        }
    }
}

export const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
export const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;

/**
 * A square emblem in three flat tones: a dome at the bottom centred on x = 200 with two holes cut out of it, a tall left ear and a short right ear that rise from it,
 * a thin line with a round dot out of each side (the left one much longer, so the box is wider on that side), and a small charm hanging from the left ear on a thin cord.
 * Its box is therefore not centred on the dome, which is what the centring tests are about.
 */
export function emblem() {
    const raster = createRaster(SIZE, SIZE);
    fill(raster, ellipse(140, 190, 24, 120), MID);
    fill(raster, ellipse(270, 260, 30, 70), MID);
    fill(raster, (x, y) => ellipse(200, 380, 80, 60)(x, y) && y <= 380, MID);
    fill(raster, (x, y) => ellipse(200, 380, 80, 60)(x, y) && y <= 380 && y > 372, DARK);
    // Two letters cut out of the dome as transparent holes, across the row the base is measured on.
    // The left hole leaves only a thin strip of dome beside it, which an opening alone would cut away.
    clear(raster, rect(138, 345, 190, 372));
    clear(raster, rect(210, 345, 240, 372));
    fill(raster, ellipse(140, 120, 8, 40), LIGHT);
    fill(raster, rect(40, 348, 120, 354), MID);
    fill(raster, ellipse(36, 351, 9, 9), MID);
    fill(raster, rect(280, 348, 300, 354), MID);
    fill(raster, ellipse(306, 351, 9, 9), MID);
    fill(raster, rect(72, 118, 118, 124), MID);
    fill(raster, ellipse(66, 121, 12, 12), LIGHT);
    return raster;
}
