// Small deterministic pictures for the pixel tools. Nothing here reads a real asset.

export function createRaster(width, height, fill = [0, 0, 0, 0]) {
    const data = Buffer.alloc(width * height * 4);
    for (let at = 0; at < data.length; at += 4) {
        data.set(fill, at);
    }
    return { width, height, data };
}

export const setPixel = (raster, x, y, colour) => raster.data.set(colour.length === 3 ? [...colour, 255] : colour, (y * raster.width + x) * 4);
export const getPixel = (raster, x, y) => [...raster.data.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4)];

/** A small seeded generator, so a "random" picture is the same on every run. */
export function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A native-size picture of blobs drawn from `colours`, with a transparent border of `margin` cells. */
export function nativeSprite(width, height, colours, { seed = 7, margin = 2 } = {}) {
    const random = seeded(seed);
    const raster = createRaster(width, height);
    for (let y = margin; y < height - margin; y++) {
        for (let x = margin; x < width - margin; x++) {
            // Blocks of 2x2 to 4x4 keep clusters, the way real pixel art does, while every cell edge still carries a change.
            const key = Math.floor(random() * colours.length);
            setPixel(raster, x, y, colours[key]);
        }
    }
    return raster;
}

/** Nearest-neighbour enlargement by a real-number factor, the way a model "upscales" pixel art. */
export function upscale(raster, factor, { offsetX = 0, offsetY = 0, canvas } = {}) {
    const outWidth = canvas?.width ?? Math.round(raster.width * factor) + offsetX;
    const outHeight = canvas?.height ?? Math.round(raster.height * factor) + offsetY;
    const out = createRaster(outWidth, outHeight);
    for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
            const sx = Math.floor((x - offsetX) / factor);
            const sy = Math.floor((y - offsetY) / factor);
            if (sx >= 0 && sy >= 0 && sx < raster.width && sy < raster.height) {
                out.data.set(raster.data.subarray((sy * raster.width + sx) * 4, (sy * raster.width + sx) * 4 + 4), (y * outWidth + x) * 4);
            }
        }
    }
    return out;
}

/** Adds small colour noise, like the speckle a model leaves inside a flat area. */
export function addNoise(raster, amount, seed = 3) {
    const random = seeded(seed);
    const out = { ...raster, data: Buffer.from(raster.data) };
    for (let at = 0; at < out.data.length; at += 4) {
        if (out.data[at + 3] === 0) {
            continue;
        }
        for (let c = 0; c < 3; c++) {
            out.data[at + c] = Math.min(255, Math.max(0, out.data[at + c] + Math.round((random() - 0.5) * 2 * amount)));
        }
    }
    return out;
}

/** A 3-tap horizontal and vertical blur on RGBA, which softens every cell edge the way resampling does. */
export function blur(raster) {
    const out = { ...raster, data: Buffer.from(raster.data) };
    const { width, height, data } = raster;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                let weight = 0;
                for (const [dx, dy, w] of [[0, 0, 4], [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1]]) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                        sum += data[(ny * width + nx) * 4 + c] * w;
                        weight += w;
                    }
                }
                out.data[(y * width + x) * 4 + c] = Math.round(sum / weight);
            }
        }
    }
    return out;
}

export function countMatches(a, b) {
    let same = 0;
    for (let at = 0; at < a.data.length; at += 4) {
        same += a.data[at] === b.data[at] && a.data[at + 1] === b.data[at + 1] && a.data[at + 2] === b.data[at + 2] && a.data[at + 3] === b.data[at + 3] ? 1 : 0;
    }
    return same / (a.data.length / 4);
}
