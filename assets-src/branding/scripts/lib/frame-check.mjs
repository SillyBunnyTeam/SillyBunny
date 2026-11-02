import { discDilate } from './frame-mask.mjs';
import { boxOfPixels, changedPixels, masterBoxOf } from './snap-frame.mjs';

const boxText = (box) => `${box.width}x${box.height} at ${box.x},${box.y}`;

/** The art pixels whose cell on the grid holds at least one pixel of a mask of master pixels. */
export function artMaskOf(mask, masterWidth, grid, art) {
    const marked = new Uint8Array(art.width * art.height);
    for (let at = 0; at < mask.length; at++) {
        if (mask[at] === 0) {
            continue;
        }
        const x = Math.floor((at % masterWidth + 0.5 - grid.offset.x) / grid.cell);
        const y = Math.floor((Math.floor(at / masterWidth) + 0.5 - grid.offset.y) / grid.cell);
        if (x >= 0 && y >= 0 && x < art.width && y < art.height) {
            marked[y * art.width + x] = 1;
        }
    }
    return marked;
}

/** The art pixels that lie wholly inside a box of master pixels. */
export function artBoxInside(box, grid, art) {
    const x0 = Math.max(0, Math.ceil((box.x - grid.offset.x) / grid.cell));
    const y0 = Math.max(0, Math.ceil((box.y - grid.offset.y) / grid.cell));
    const x1 = Math.min(art.width, Math.floor((box.x + box.width - grid.offset.x) / grid.cell));
    const y1 = Math.min(art.height, Math.floor((box.y + box.height - grid.offset.y) / grid.cell));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

const isInside = (box, x, y) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;

/**
 * Compares a frame snap with its base snap where the frame was made by taking only a masked part of an edit. The pixels that changed must lie inside the mask,
 * as art pixels, grown by `margin` art pixels (the rings and the sampling reach that far), not inside one rectangle; and no part the base was to keep (`keep`,
 * boxes of master pixels) may have changed in the art pixels that lie wholly in it, or the frame is refused, as is a frame that changed nothing.
 * @param {{ base: import('./raster.mjs').Raster, frame: import('./raster.mjs').Raster, cut: Uint8Array, masterWidth: number, grid: { cell: number, offset: { x: number, y: number } },
 *   keep: { name: string, box: { x: number, y: number, width: number, height: number } }[], margin: number }} request
 * @returns {{ changed: number, box: object, masterBox: object, allowed: number, keep: { name: string, box: object | null, pixels: number, changed: number }[] }}
 */
export function checkMaskedFrame({ base, frame, cut, masterWidth, grid, keep, margin }) {
    const indexes = changedPixels(base, frame);
    if (indexes.length === 0) {
        throw new Error('The frame is identical to its base on the grid: no art pixel changed. Check that the edit differs from the base.');
    }
    const art = { width: base.width, height: base.height };
    const allowed = discDilate(artMaskOf(cut, masterWidth, grid, art), art.width, art.height, margin);
    const outside = indexes.filter((index) => allowed[index] === 0);
    if (outside.length > 0) {
        const where = boxOfPixels(outside, art.width);
        throw new Error(`${outside.length} of the ${indexes.length} art pixels that changed lie outside the mask grown by ${margin} art px: they are in ${boxText(where)} art px. The snap changed what the mask kept from the base; nothing was written.`);
    }
    const kept = keep.map(({ name, box }) => {
        const inside = artBoxInside(box, grid, art);
        const differing = inside ? indexes.filter((index) => isInside(inside, index % art.width, Math.floor(index / art.width))).length : 0;
        return { name, box: inside ?? null, pixels: inside ? inside.width * inside.height : 0, changed: differing };
    });
    const disturbed = kept.filter(({ changed }) => changed > 0);
    if (disturbed.length > 0) {
        throw new Error(`${disturbed.map(({ name, changed, pixels }) => `the kept part "${name}" changed in ${changed} of its ${pixels} art px`).join('; ')}. A kept part must be the base's own on the grid; nothing was written.`);
    }
    const box = boxOfPixels(indexes, art.width);
    return { changed: indexes.length, box, masterBox: masterBoxOf(box, grid), allowed: allowed.reduce((total, value) => total + value, 0), keep: kept };
}
