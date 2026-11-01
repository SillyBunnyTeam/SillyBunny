import { DARK, LIGHT, MID, ellipse, rect } from './emblem.mjs';
import { createRaster } from './synthetic.mjs';

export const SIZE = 400;
export const LINE_WIDTH = 7;
export const DOT_RADIUS = 14;
// The dots' centres and the rows of the lines, as the picture is drawn.
export const LEFT_DOT = { cx: 40, cy: 280.5 };
export const RIGHT_DOT = { cx: 360, cy: 299.5 };

function paint(raster, inside, colour) {
    for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
            if (inside(x + 0.5, y + 0.5)) {
                raster.data.set([...colour, 255], (y * raster.width + x) * 4);
            }
        }
    }
}

/**
 * A logo of three flat tones the way the real one is built, small enough for tests: a dome with the letters cut out of it and a dark
 * lower band, two ears standing on it, and two lines that each end in a round dot. The one on the left turns twice (a horizontal piece,
 * a vertical one and a horizontal one that meets the dome) and the one on the right is straight. The lines are 7 pixels wide and the dots
 * 28, and every edge of a line is on a whole pixel.
 */
export function logoWithLines() {
    const raster = createRaster(SIZE, SIZE);
    const dome = (x, y) => ellipse(200, 340, 110, 90)(x, y) && y <= 340;
    paint(raster, ellipse(150, 170, 22, 100), MID);
    paint(raster, ellipse(250, 190, 20, 80), MID);
    paint(raster, dome, MID);
    paint(raster, (x, y) => dome(x, y) && y > 330, DARK);
    paint(raster, ellipse(150, 170, 8, 60), LIGHT);
    for (const hole of [rect(160, 295, 190, 325), rect(210, 295, 240, 325)]) {
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                if (hole(x + 0.5, y + 0.5)) {
                    raster.data.set([0, 0, 0, 0], (y * SIZE + x) * 4);
                }
            }
        }
    }
    paint(raster, rect(40, 277, 71, 284), MID);
    paint(raster, rect(67, 277, 74, 319), MID);
    paint(raster, rect(67, 312, 130, 319), MID);
    paint(raster, ellipse(LEFT_DOT.cx, LEFT_DOT.cy, DOT_RADIUS, DOT_RADIUS), MID);
    paint(raster, rect(270, 296, 360, 303), MID);
    paint(raster, ellipse(RIGHT_DOT.cx, RIGHT_DOT.cy, DOT_RADIUS, DOT_RADIUS), MID);
    return raster;
}

