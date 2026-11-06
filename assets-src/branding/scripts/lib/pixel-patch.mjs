import { formatHex } from './pixel-colour.mjs';

const KEYS = new Set(['x', 'y', 'w', 'h', 'color']);
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * Parses a pixel-fix patch: a list of `{ x, y, color }` points and `{ x, y, w, h, color }` rectangles in native pixels.
 * `color` is `#rrggbb` or `transparent`.
 * @param {any} raw
 * @param {{ width: number, height: number }} picture
 */
export function parsePixelPatch(raw, picture) {
    if (!Array.isArray(raw)) {
        throw new Error('A pixel patch must be a list of edits.');
    }
    if (raw.length === 0) {
        throw new Error('A pixel patch needs at least one edit.');
    }
    return raw.map((edit, index) => {
        const name = `edit ${index + 1}`;
        for (const key of Object.keys(edit ?? {})) {
            if (!KEYS.has(key)) {
                throw new Error(`${name}: unknown key "${key}". Known keys: ${[...KEYS].join(', ')}.`);
            }
        }
        const match = typeof edit.color === 'string' ? HEX.exec(edit.color) : undefined;
        if (edit.color === undefined) {
            throw new Error(`${name}: color is required (#rrggbb or transparent).`);
        }
        if (edit.color !== 'transparent' && !match) {
            throw new Error(`${name}: color "${edit.color}" must be #rrggbb or transparent.`);
        }
        if (!Number.isInteger(edit.x) || !Number.isInteger(edit.y)) {
            throw new Error(`${name}: x and y must be whole numbers.`);
        }
        if ((edit.w === undefined) !== (edit.h === undefined)) {
            throw new Error(`${name}: give both w and h for a rectangle, or neither for a single pixel.`);
        }
        const width = edit.w ?? 1;
        const height = edit.h ?? 1;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
            throw new Error(`${name}: w and h must be whole numbers of 1 or more.`);
        }
        if (edit.x < 0 || edit.y < 0 || edit.x + width > picture.width || edit.y + height > picture.height) {
            throw new Error(`${name}: the area x ${edit.x}, y ${edit.y}, ${width}x${height} is outside the ${picture.width}x${picture.height} picture.`);
        }
        return { x: edit.x, y: edit.y, width, height, rgba: match ? [1, 2, 3].map((group) => Number.parseInt(match[group], 16)).concat(255) : [0, 0, 0, 0] };
    });
}

/**
 * Applies the edits in order to a copy of the picture. `changed` counts pixels whose final value differs from the input.
 * @param {import('./raster.mjs').Raster} raster
 * @param {ReturnType<typeof parsePixelPatch>} ops
 */
export function applyPixelPatch(raster, ops) {
    const fixed = { ...raster, data: Buffer.from(raster.data) };
    for (const { x, y, width, height, rgba } of ops) {
        for (let row = y; row < y + height; row++) {
            for (let column = x; column < x + width; column++) {
                fixed.data.set(rgba, (row * raster.width + column) * 4);
            }
        }
    }
    let changed = 0;
    for (let at = 0; at < raster.data.length; at += 4) {
        const differs = [0, 1, 2, 3].some((offset) => raster.data[at + offset] !== fixed.data[at + offset]);
        changed += differs ? 1 : 0;
    }
    return { raster: fixed, changed };
}

/** How many distinct pixels the edits cover, however often they overlap. */
export function listedPixels(ops) {
    const covered = new Set();
    for (const { x, y, width, height } of ops) {
        for (let row = y; row < y + height; row++) {
            for (let column = x; column < x + width; column++) {
                covered.add(row * 65536 + column);
            }
        }
    }
    return covered.size;
}

/** Hex colours the patch paints that the palette does not contain. Transparent is never off-palette. */
export function offPaletteColours(ops, palette) {
    const known = new Set(palette.map(formatHex));
    const unknown = ops.filter(({ rgba }) => rgba[3] === 255).map(({ rgba }) => formatHex(rgba.slice(0, 3))).filter((hex) => !known.has(hex));
    return [...new Set(unknown)];
}
