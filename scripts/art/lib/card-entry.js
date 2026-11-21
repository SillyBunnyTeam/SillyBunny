const CARD_KEYS = Object.freeze(['type', 'key', 'master', 'crop', 'grid', 'gradient', 'text', 'world', 'outputs']);
const HEX_PATTERN = /^#[0-9a-f]{6}$/;
const CARD_FILE_PATTERN = /^default\/content\/[^/]+\.png$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWholeList = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isInteger);

/**
 * Checks the shape of a card entry: the sprite master, the crop of it that the card shows at scale 1, the gradient behind
 * the sprite, the card file whose text the card carries, the world it links, and the one card file it ships.
 * @param {any} asset
 * @param {(message: string) => void} fail
 * @param {{ onlyKeys: Function, checkMaster: Function, checkGrid: Function, checkOutputs: Function, isSafeRelative: (path: string) => boolean }} checks
 *   The manifest's own checks of keys, masters, grids, outputs and paths.
 */
export function checkCardEntry(asset, fail, { onlyKeys, checkMaster, checkGrid, checkOutputs, isSafeRelative }) {
    onlyKeys(asset, CARD_KEYS, 'The card', fail);
    if (asset.key !== null) {
        fail('key must be null: the app seeds a card from default/content/, which no art cache key covers.');
    }
    checkMaster(asset.master, '.png', fail);
    checkGrid(asset.grid, fail);
    const { crop, grid } = asset;
    if (!isWholeList(crop, 4) || crop[2] < 1 || crop[3] < 1) {
        fail('crop must be [left, top, width, height] in whole master pixels: the part of the master that the card shows.');
    } else if (Array.isArray(grid) && (crop[2] !== grid[0] || crop[3] !== grid[1])) {
        fail(`The crop is ${crop[2]}x${crop[3]}, but the grid is ${grid.join('x')}; the crop is the card at scale 1, so the two must be equal.`);
    }
    const { gradient } = asset;
    if (!isPlainObject(gradient) || Object.keys(gradient).length !== 2 || !HEX_PATTERN.test(gradient.top) || !HEX_PATTERN.test(gradient.bottom)) {
        fail('gradient must be { "top": "#rrggbb", "bottom": "#rrggbb" } in lowercase hex.');
    }
    if (typeof asset.text !== 'string' || !isSafeRelative(asset.text) || !asset.text.endsWith('.png')) {
        fail(`text must be the path of the card file whose text the card carries, a .png inside the checkout, got ${JSON.stringify(asset.text)}.`);
    }
    if (typeof asset.world !== 'string' || asset.world === '') {
        fail('world must name the World Info book that the card links to.');
    }
    checkOutputs(asset.outputs, 'outputs', fail, { encoded: true });
    const [output, ...others] = Array.isArray(asset.outputs) ? asset.outputs : [];
    if (others.length > 0 || output?.encoding !== 'png-card' || output?.from !== undefined || !CARD_FILE_PATTERN.test(output?.path ?? '')) {
        fail('A card ships exactly one file: a .png directly in default/content/, with the encoding png-card.');
    }
}

/**
 * @param {string} hex Such as `#f5e9ff`.
 * @returns {[number, number, number]}
 */
export const rgbOf = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
