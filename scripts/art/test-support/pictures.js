import { fileURLToPath } from 'node:url';

/** The root of the SillyBunny checkout that holds this package. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => number[]} colourOf Returns [r, g, b, a].
 * @param {3 | 4} [channels]
 * @returns {import('../lib/raster.js').Raster}
 */
export function paint(width, height, colourOf, channels = 4) {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            data.set(colourOf(x, y), (y * width + x) * 4);
        }
    }
    return { width, height, data, channels };
}

/**
 * @param {import('../lib/raster.js').Raster} raster
 * @param {number} x
 * @param {number} y
 * @returns {number[]} [r, g, b, a]
 */
export const pixelAt = (raster, x, y) => [...raster.data.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4)];
