import sharp from 'sharp';

/** @param {string} value like #00FF00 or 00ff00 */
export function parseHexColour(value) {
    const match = /^#?([0-9a-f]{6})$/i.exec(value);
    if (!match) {
        throw new Error(`Colour must be a 6-digit hex value like #00FF00, got "${value}".`);
    }
    const hex = match[1];
    return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

/**
 * Keys a flat background to alpha in place on an RGBA buffer.
 * Pixels within `tolerance` of the key become transparent; pixels within the next `softness`
 * are feathered. Any pixel that stays visible has the key's dominant channel clamped to the
 * other two, which removes the coloured fringe the background leaves on edges.
 * Every pixel of the key colour is keyed, so a figure must not contain that colour.
 * @param {Buffer} rgba
 * @param {{ key: number[], tolerance: number, softness: number }} options
 */
export function keyPixels(rgba, { key, tolerance, softness }) {
    const dominant = key.indexOf(Math.max(...key));
    const others = [0, 1, 2].filter((channel) => channel !== dominant);
    for (let at = 0; at < rgba.length; at += 4) {
        const distance = Math.hypot(rgba[at] - key[0], rgba[at + 1] - key[1], rgba[at + 2] - key[2]);
        if (distance <= tolerance) {
            rgba[at + 3] = 0;
            continue;
        }
        if (distance < tolerance + softness) {
            rgba[at + 3] = Math.round(rgba[at + 3] * ((distance - tolerance) / softness));
        }
        const limit = Math.max(rgba[at + others[0]], rgba[at + others[1]]);
        if (rgba[at + dominant] > limit) {
            rgba[at + dominant] = limit;
        }
    }
    return rgba;
}

/**
 * @param {string} inPath
 * @param {string} outPath
 * @param {{ key: number[], tolerance: number, softness: number }} options
 */
export async function keyBackgroundFile(inPath, outPath, options) {
    const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    keyPixels(data, options);
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(outPath);
}
