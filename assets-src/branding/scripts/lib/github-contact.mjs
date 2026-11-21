import { parseHex } from './github-colour.mjs';

/** @typedef {import('./raster.mjs').Raster} Raster */
/** @typedef {{ x0: number, x1: number, y: number }} Contact a run of columns of the art, and the row of art pixels that is its lowest point */

const OPAQUE = 128;

/**
 * For every column, whether the `radius` pixels either side of it are all set in the row, by prefix sums.
 * @param {Uint8Array} flags one row, 1 where set
 */
function allWithin(flags, radius) {
    const prefix = new Int32Array(flags.length + 1);
    for (let at = 0; at < flags.length; at++) {
        prefix[at + 1] = prefix[at] + flags[at];
    }
    return Uint8Array.from(flags, (_, at) => (at - radius >= 0 && at + radius < flags.length && prefix[at + radius + 1] - prefix[at - radius] === 2 * radius + 1 ? 1 : 0));
}

/** The pixels of the art that are still opaque when every opaque pixel loses `inset` pixels on all sides: the figure without its sticker rings. */
function erodedMask(art, inset) {
    const { width, height, data } = art;
    const across = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const row = Uint8Array.from({ length: width }, (_, x) => (data[(y * width + x) * 4 + 3] >= OPAQUE ? 1 : 0));
        across.set(allWithin(row, inset), y * width);
    }
    const mask = new Uint8Array(width * height);
    for (let x = 0; x < width; x++) {
        const column = Uint8Array.from({ length: height }, (_, y) => across[y * width + x]);
        const kept = allWithin(column, inset);
        for (let y = 0; y < height; y++) {
            mask[y * width + x] = kept[y];
        }
    }
    return mask;
}

/**
 * Where a picture of characters and props touches the ground. The sticker's rings are taken off first (`inset` pixels all round), so the
 * lowest point of a shoe is the sole and not the white rim under it. Then every column gets its lowest figure pixel, the columns whose lowest
 * pixel is within `reach` pixels of the lowest of all are the ones on the ground (a hand, a hem or a megaphone is higher than that), and
 * neighbouring such columns, up to `gap` apart, are one contact: a shoe, a sock, a leg of a bench, the whole base of a mortar.
 * @param {Raster} art the drawn picture, in art pixels
 * @param {{ inset?: number, reach?: number, gap?: number, minWidth?: number }} [options]
 * @returns {Contact[]} left to right
 */
export function findContacts(art, { inset = 4, reach = 14, gap = 3, minWidth = 3 } = {}) {
    const mask = erodedMask(art, inset);
    const bottoms = Int32Array.from({ length: art.width }, (_, x) => {
        for (let y = art.height - 1; y >= 0; y--) {
            if (mask[y * art.width + x]) {
                return y;
            }
        }
        return -1;
    });
    const lowest = Math.max(...bottoms);
    if (lowest < 0) {
        throw new Error(`The art has no figure left once its ${inset} pixel rings are taken off, so there is nothing to find a contact on.`);
    }
    const contacts = [];
    let open;
    for (let x = 0; x < art.width; x++) {
        if (bottoms[x] < lowest - reach) {
            continue;
        }
        if (open && x - open.x1 <= gap + 1) {
            open.x1 = x;
            open.y = Math.max(open.y, bottoms[x]);
            continue;
        }
        open = { x0: x, x1: x, y: bottoms[x] };
        contacts.push(open);
    }
    return contacts.filter(({ x0, x1 }) => x1 - x0 + 1 >= minWidth);
}

/**
 * What a shadow of each kind looks like. The width follows the width of the thing that casts it: `spread` is the half width of the
 * sticker round it, times this. The height is the same for every width, `rows` blocks of the ground each side of the middle, so that the
 * shadow of a wide base is as thick as the shadow of a shoe and fits in the ground under the lowest sticker. `sunk` is where the middle
 * lies, as a share of the sticker's rings from the sole (1 is the bottom edge of the rings, where the ground shows). A contact is tight
 * under a sole, a knee or a leg; a footprint is wider and lies under a whole bench, desk, mortar or box, up into the space between its
 * legs; a raised part hangs in the air, so its small shadow is on the ground row it is given, with no ring to sink into. A footprint is
 * `flat`: its bands are squared across its width, so that it darkens the whole of a base evenly and fades only at the ends, where an
 * ellipse would be at its faintest under the legs of a bench.
 */
const SHAPES = Object.freeze({
    contact: Object.freeze({ spread: 1.5, rows: 3, sunk: 1, flat: false }),
    footprint: Object.freeze({ spread: 1.7, rows: 4, sunk: 0.5, flat: true }),
    raised: Object.freeze({ spread: 1, rows: 2, sunk: 0, flat: false }),
});

export const CONTACT_KINDS = Object.freeze(Object.keys(SHAPES));

/** @typedef {{ kind: 'contact' | 'footprint' | 'raised', x0: number, x1: number, y: number, strength?: number }} Shadowed */

/** The darkening of an entry at its middle: its own `strength` when it has one, else the one of its kind. */
export const strengthOf = (entry, strengths) => entry.strength ?? strengths[entry.kind];

/**
 * The ellipse that an entry darkens, in pixels of the canvas. Its width follows the width of the sticker round the entry, so a wide base
 * has a wide shadow and a shoe a small one, in the same proportion everywhere. `offset` moves it in blocks of the ground: to the right
 * for a light from the upper left.
 * @param {Shadowed} entry
 * @param {{ box: { x: number, y: number }, step: number, grid: { step: number }, inset: number, offset: { x: number, y: number } }} placing
 */
export function shadowEllipse({ kind, x0, x1, y }, { box, step, grid, inset, offset }) {
    const shape = SHAPES[kind];
    const stickerWidth = (x1 - x0 + 1 + 2 * inset) * step;
    const radiusX = (stickerWidth / 2) * shape.spread;
    return {
        centreX: box.x + ((x0 + x1 + 1) / 2) * step + offset.x * grid.step,
        centreY: box.y + (y + 1 + shape.sunk * inset) * step + offset.y * grid.step,
        radiusX,
        radiusY: shape.rows * grid.step,
        flat: shape.flat,
    };
}

/**
 * Darkens the ground under the entries of art that is about to be drawn: for each a flat ellipse in bands, in whole cells of the
 * backdrop's blocks, so the shadow is made of the same blocks as the plate it lies on. Each pixel of a shadowed cell is multiplied by the
 * tint, as much as the band says, so the shadow is the ground's own colour and texture made darker and not a flat patch laid on it.
 * Where ellipses overlap, a cell takes the strongest of them and is not darkened twice.
 * @param {Raster} canvas painted in place
 * @param {{ contacts: Shadowed[], box: { x: number, y: number }, step: number, grid: { x: number, y: number, step: number }, tint: string, strengths: Record<string, number>, bands: number, inset: number, offset: { x: number, y: number } }} shadow
 * `box` and `step` place the art on the canvas; `grid` is the block grid of the backdrop; a strength is the darkening of the middle band, from 0 to 1
 * @returns {{ cells: number }} how many cells of the ground were darkened
 */
export function paintContactShadows(canvas, { contacts, box, step, grid, tint, strengths, bands, inset, offset }) {
    const { r, g, b } = parseHex(tint);
    const tints = [r, g, b].map((channel) => channel / 255);
    const strengthOfCell = new Map();
    for (const entry of contacts) {
        const { centreX, centreY, radiusX, radiusY, flat } = shadowEllipse(entry, { box, step, grid, inset, offset });
        const strength = strengthOf(entry, strengths);
        const firstColumn = Math.floor((centreX - radiusX - grid.x) / grid.step);
        const lastColumn = Math.ceil((centreX + radiusX - grid.x) / grid.step);
        const firstRow = Math.floor((centreY - radiusY - grid.y) / grid.step);
        const lastRow = Math.ceil((centreY + radiusY - grid.y) / grid.step);
        for (let row = firstRow; row <= lastRow; row++) {
            for (let column = firstColumn; column <= lastColumn; column++) {
                const across = Math.abs(grid.x + (column + 0.5) * grid.step - centreX) / radiusX;
                const distance = Math.hypot(flat ? across * across : across, (grid.y + (row + 0.5) * grid.step - centreY) / radiusY);
                if (distance >= 1) {
                    continue;
                }
                const band = Math.floor(distance * bands);
                const key = `${column},${row}`;
                strengthOfCell.set(key, Math.max(strengthOfCell.get(key) ?? 0, (strength * (bands - band)) / bands));
            }
        }
    }
    for (const [key, amount] of strengthOfCell) {
        const [column, row] = key.split(',').map(Number);
        const left = grid.x + column * grid.step;
        const top = grid.y + row * grid.step;
        for (let y = Math.max(0, top); y < Math.min(canvas.height, top + grid.step); y++) {
            for (let x = Math.max(0, left); x < Math.min(canvas.width, left + grid.step); x++) {
                const at = (y * canvas.width + x) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    canvas.data[at + channel] = Math.round(canvas.data[at + channel] * (1 - amount + amount * tints[channel]));
                }
            }
        }
    }
    return { cells: strengthOfCell.size };
}

/**
 * Proposes runs to put in a scene's config, for a person to place by eye: the columns on the ground are proposed as contacts, and the
 * parts that end higher (within `raisedReach`, a hand excluded) as raised ones, standing on the row of the lowest contact. Detection
 * cannot tell a foot on the ground from one in the air, and it cannot see a bench seat or a kneeling shin, so nothing here is used by a
 * build: the config lists the contacts.
 * @param {Raster} art
 * @param {{ inset?: number, reach?: number, raisedReach?: number, gap?: number, minWidth?: number }} [options]
 * @returns {Shadowed[]} left to right; none when no run on the ground is wide enough, since a raised part needs a ground row to stand on
 */
export function proposeContacts(art, { inset = 4, reach = 14, raisedReach = 60, gap = 3, minWidth = 3 } = {}) {
    const onGround = findContacts(art, { inset, reach, gap, minWidth });
    if (onGround.length === 0) {
        return [];
    }
    const ground = Math.max(...onGround.map(({ y }) => y));
    const overlaps = (one, two) => one.x0 <= two.x1 && two.x0 <= one.x1;
    const raised = findContacts(art, { inset, reach: raisedReach, gap, minWidth })
        .filter((run) => !onGround.some((contact) => overlaps(contact, run)))
        .map(({ x0, x1 }) => ({ kind: 'raised', x0, x1, y: ground }));
    return [...onGround.map((run) => ({ kind: 'contact', ...run })), ...raised].sort((one, two) => one.x0 - two.x0);
}
