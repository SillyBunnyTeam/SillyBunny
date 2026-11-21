/** @typedef {import('./raster.mjs').Raster} Raster */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ rimWidth: number, bandWidth: number, rim: number[], band: number[] }} Rings the widths in art pixels and the two colours of a sticker */

const isClear = (raster, x, y) => raster.data[(y * raster.width + x) * 4 + 3] === 0;
const inRect = ({ x, y }, rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;

/**
 * The distance from a pixel to the nearest pixel that `isTarget` accepts, looking no further than `reach`; Infinity when there is none
 * that near. Pixels outside the picture are not targets.
 */
function distanceWithin(raster, x, y, reach, isTarget) {
    let nearest = Infinity;
    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < raster.width && ny < raster.height && isTarget(nx, ny)) {
                nearest = Math.min(nearest, Math.hypot(dx, dy));
            }
        }
    }
    return nearest;
}

/**
 * Checks that a rectangle is a whole rectangle of the picture. Fails on anything else, so a repair cannot reach past the edge or be empty.
 * @param {Raster} native
 * @param {Rect} rect
 */
export function assertRectInside(native, rect) {
    const whole = [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger);
    if (!whole || rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > native.width || rect.y + rect.height > native.height) {
        throw new Error(`The repair box ${JSON.stringify(rect)} must be whole pixels inside the ${native.width}x${native.height} picture.`);
    }
}

/**
 * Erases boxes of a snapped picture and draws the sticker's rings whole along what is left. Inside the boxes everything is made
 * transparent, then a rim and a white band are grown from the drawing that is left: every transparent pixel of a box that is within
 * `rimWidth + bandWidth` pixels of the drawing's inside (the pixels that are deeper in than the rings are) becomes ring, the nearest
 * `rimWidth` to the transparent space in the rim colour and the next `bandWidth` in the band colour. This is how a prop's detail that the
 * artist drew twice is removed: the rings of the old shape go with it and the rings of the new one are drawn. Nothing outside the
 * boxes changes. The drawing's inside is found before the erase, so the old rings are never taken for it.
 * @param {Raster} native a snapped picture, with binary alpha
 * @param {Rect[]} boxes
 * @param {Rings} rings
 * @returns {{ raster: Raster, erased: number, grown: number }}
 */
export function eraseWithRings(native, boxes, { rimWidth, bandWidth, rim, band }) {
    for (const box of boxes) {
        assertRectInside(native, box);
    }
    const reach = rimWidth + bandWidth;
    const inAnyBox = (x, y) => boxes.some((box) => inRect({ x, y }, box));
    // Deeper than the rings from the transparent space: the drawing itself.
    const isInside = new Uint8Array(native.width * native.height);
    for (let y = 0; y < native.height; y++) {
        for (let x = 0; x < native.width; x++) {
            const opaque = !isClear(native, x, y);
            isInside[y * native.width + x] = opaque && !inAnyBox(x, y) && distanceWithin(native, x, y, reach + 1, (nx, ny) => isClear(native, nx, ny)) > reach + 1e-6 ? 1 : 0;
        }
    }
    const raster = { ...native, data: Buffer.from(native.data) };
    let erased = 0;
    for (const box of boxes) {
        for (let y = box.y; y < box.y + box.height; y++) {
            for (let x = box.x; x < box.x + box.width; x++) {
                erased += isClear(raster, x, y) ? 0 : 1;
                raster.data.fill(0, (y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4);
            }
        }
    }
    const grow = [];
    for (const box of boxes) {
        for (let y = box.y; y < box.y + box.height; y++) {
            for (let x = box.x; x < box.x + box.width; x++) {
                if (distanceWithin(raster, x, y, reach, (nx, ny) => isInside[ny * raster.width + nx] === 1) <= reach + 1e-6) {
                    grow.push([x, y]);
                }
            }
        }
    }
    // The silhouette with the grown pixels in it, so that the colour of each one follows from how deep it is.
    const silhouette = { ...raster, data: Buffer.from(raster.data) };
    for (const [x, y] of grow) {
        silhouette.data.set([0, 0, 0, 255], (y * silhouette.width + x) * 4);
    }
    for (const [x, y] of grow) {
        const depth = distanceWithin(silhouette, x, y, reach + 1, (nx, ny) => isClear(silhouette, nx, ny));
        raster.data.set([...(depth <= rimWidth + 1e-6 ? rim : band), 255], (y * raster.width + x) * 4);
    }
    return { raster, erased, grown: grow.length };
}
