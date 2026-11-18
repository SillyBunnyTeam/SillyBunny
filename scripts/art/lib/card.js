import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rgbOf } from './card-entry.js';
import { encode } from './codec.js';
import { renderFrame } from './frame.js';
import { outputFile } from './manifest.js';
import { ArtProblem } from './problem.js';
import { createRaster, isOpaque, opaqueBox, paste, sha256, upscaleNearest } from './raster.js';

// The card text is written by the app's own writer, so the app reads the card as one it wrote itself: its V2 and V3
// conversion, its chunk keywords and its chunk order. The parser has no side effects when imported, and the packages it
// imports come from the root node_modules.
const APP_PARSER = new URL('../../../src/character-card-parser.js', import.meta.url);
const V3 = Object.freeze({ spec: 'chara_card_v3', spec_version: '3.0' });
const V2 = Object.freeze({ spec: 'chara_card_v2', spec_version: '2.0' });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The app's card writer and reader, and the PNG chunk reader they use.
 * @throws {ArtProblem} `card-parser-missing` when the root packages are not installed.
 */
export async function loadAppCardParser() {
    try {
        const { read, write } = await import(APP_PARSER.href);
        const { default: extract } = await import('png-chunks-extract');
        const { default: PNGtext } = await import('png-chunk-text');
        return { read, write, extract, decodeText: PNGtext.decode };
    } catch (error) {
        throw new ArtProblem('card-parser-missing', `The app's card parser (${fileURLToPath(APP_PARSER)}) could not be loaded: ${error.message}. Run npm ci in the repository root first.`);
    }
}

/**
 * The picture of a card: an opaque native master with every art pixel drawn as `scale` by `scale` pixels, stored as
 * 8-bit RGB with no palette, so it decodes to exactly those pixels.
 * @param {import('./raster.js').Raster} master
 * @param {number} scale
 * @returns {Promise<Buffer>}
 * @throws {ArtProblem} `scale-invalid` for a scale that is not a whole number of 1 or more, and `master-not-opaque`
 *   for a master with a transparent pixel.
 */
export async function cardPicture(master, scale) {
    if (!Number.isInteger(scale) || scale < 1) {
        throw new ArtProblem('scale-invalid', `A card is its master enlarged by a whole scale of 1 or more, got ${scale}.`);
    }
    if (!isOpaque(master)) {
        throw new ArtProblem('master-not-opaque', 'The card master has transparent pixels, but a card is opaque.');
    }
    return encode(upscaleNearest({ ...master, channels: 3 }, scale), 'png-card');
}

/**
 * The card to embed: the V3 card with the two edits a build may make, `data.extensions.world` set to `world` and
 * `data.character_book` removed. No other field changes, and the source is not changed.
 * @param {any} source The parsed card file.
 * @param {string} world
 * @returns {{ card: any, edits: { path: string, change: 'set' | 'removed', from: unknown, to?: unknown }[] }}
 * @throws {ArtProblem} `card-invalid` for a file that is not a V3 card with a name.
 */
export function prepareCard(source, world) {
    if (!isObject(source) || source.spec !== V3.spec || source.spec_version !== V3.spec_version) {
        throw new ArtProblem('card-invalid', `The card file is not a V3 card: spec must be "${V3.spec}" and spec_version "${V3.spec_version}", got ${JSON.stringify(source?.spec)} and ${JSON.stringify(source?.spec_version)}.`);
    }
    if (!isObject(source.data) || typeof source.data.name !== 'string' || source.data.name === '') {
        throw new ArtProblem('card-invalid', 'The card file has no data.name, so it is not a card.');
    }
    if (source.data.extensions !== undefined && !isObject(source.data.extensions)) {
        throw new ArtProblem('card-invalid', 'data.extensions of the card file must be an object.');
    }
    const card = structuredClone(source);
    const edits = [];
    card.data.extensions ??= {};
    if (card.data.extensions.world !== world) {
        edits.push({ path: 'data.extensions.world', change: 'set', from: source.data.extensions?.world, to: world });
        card.data.extensions.world = world;
    }
    if ('character_book' in card.data) {
        edits.push({ path: 'data.character_book', change: 'removed', from: Array.isArray(card.data.character_book?.entries) ? `${card.data.character_book.entries.length} entries` : typeof card.data.character_book });
        delete card.data.character_book;
    }
    return { card, edits };
}

/**
 * Writes the card into a PNG with the app's writer: a `chara` chunk with the V2 card and a `ccv3` chunk with the V3
 * card, each base64 of the JSON, before IEND.
 * @param {Buffer} png
 * @param {any} card
 * @returns {Promise<Buffer>}
 */
export async function embedCard(png, card) {
    const { write } = await loadAppCardParser();
    return write(png, JSON.stringify(card));
}

/** The `[path, value]` of every leaf of a JSON value, where an empty list or object counts as one leaf. */
function leavesOf(value, path = '') {
    if (Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0) {
        return Object.entries(value).flatMap(([key, inner]) => leavesOf(inner, path ? `${path}.${key}` : key));
    }
    return [[path, value]];
}

/**
 * The paths at which two cards differ, with both values; none when every field is the same. Values are compared as the
 * JSON they are written as.
 * @returns {{ path: string, expected: unknown, actual: unknown }[]}
 */
export function differences(expected, actual) {
    const wanted = new Map(leavesOf(expected));
    const found = new Map(leavesOf(actual));
    const paths = [...new Set([...wanted.keys(), ...found.keys()])];
    return paths
        .filter((path) => !(wanted.has(path) && found.has(path) && JSON.stringify(wanted.get(path)) === JSON.stringify(found.get(path))))
        .map((path) => ({ path, expected: wanted.get(path), actual: found.get(path) }));
}

/**
 * Reads a built card back the way the app does and compares it with the card that went in: the text chunks are exactly
 * `chara` and `ccv3`, the V3 card the app's reader returns is the card field for field, the `chara` chunk is the same
 * card as V2, and `world` is set with no `character_book`.
 * @param {Buffer} png
 * @param {any} card The card as it should read back.
 * @param {string} world
 * @returns {Promise<{ chunks: string[], fields: number, v3: any, v2: any }>}
 * @throws {ArtProblem} `card-readback`, naming every difference.
 */
export async function verifyCard(png, card, world) {
    const { read, extract, decodeText } = await loadAppCardParser();
    const texts = extract(new Uint8Array(png)).filter((chunk) => chunk.name === 'tEXt').map((chunk) => decodeText(chunk.data));
    const chunks = texts.map(({ keyword }) => keyword);
    const problems = [];
    if (chunks.length !== 2 || !chunks.includes('chara') || !chunks.includes('ccv3')) {
        problems.push(`the text chunks are [${chunks.join(', ')}], not "chara" and "ccv3"`);
    }
    let v3;
    try {
        v3 = JSON.parse(read(png));
    } catch (error) {
        problems.push(`the app's reader refused the card: ${error.message}`);
    }
    const charaText = texts.find(({ keyword }) => keyword === 'chara');
    const v2 = charaText ? JSON.parse(Buffer.from(charaText.text, 'base64').toString('utf8')) : undefined;
    for (const [name, found, expected] of [['ccv3', v3, { ...card, ...V3 }], ['chara', v2, { ...card, ...V2 }]]) {
        if (!found) {
            continue;
        }
        for (const { path, expected: wanted, actual } of differences(expected, found)) {
            problems.push(`${name} chunk: ${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
        }
        if (found.data?.extensions?.world !== world) {
            problems.push(`${name} chunk: data.extensions.world is ${JSON.stringify(found.data?.extensions?.world)}, not ${JSON.stringify(world)}`);
        }
        if (found.data && 'character_book' in found.data) {
            problems.push(`${name} chunk: data.character_book is present`);
        }
    }
    if (problems.length > 0) {
        throw new ArtProblem('card-readback', `The built card does not read back as the card it was made from:\n  ${problems.join('\n  ')}`);
    }
    return { chunks, fields: leavesOf(card).length, v3, v2 };
}

/**
 * Builds a card in memory from an opaque native master and a V3 card: the picture at a whole scale, the card text
 * written by the app's writer, and the readback, which refuses the card on any difference. Nothing is written.
 * @param {{ master: import('./raster.js').Raster, scale: number, source: any, world: string }} input
 * @returns {Promise<{ png: Buffer, edits: object[], chunks: string[], fields: number }>}
 */
export async function buildCard({ master, scale, source, world }) {
    const { card, edits } = prepareCard(source, world);
    const png = await embedCard(await cardPicture(master, scale), card);
    const { chunks, fields } = await verifyCard(png, card, world);
    return { png, edits, chunks, fields };
}

/**
 * The colour of one row of the card's vertical gradient: `top` on the first row and `bottom` on the last, each channel
 * rounded with `Math.round`. The art repository composes the card that a person approves with this same rule, so a
 * change here makes the shipped card differ from the approved one.
 * @param {{ top: string, bottom: string }} gradient
 * @param {number} row
 * @param {number} height
 * @returns {number[]} [r, g, b]
 */
export function gradientRow({ top, bottom }, row, height) {
    const [from, to] = [rgbOf(top), rgbOf(bottom)];
    return from.map((channel, at) => (height === 1 ? channel : Math.round(channel + ((to[at] - channel) * row) / (height - 1))));
}

/**
 * The card at scale 1, an opaque native master of the whole card: the crop of a sprite master laid over the gradient. The
 * crop may reach past the master's top and sides, where the gradient shows. It may not cut off the top of the figure, and
 * its last row must cut the figure, as at the waist, because a gap under the figure would show as a band of gradient.
 * @param {import('./raster.js').Raster} master A sprite master with binary alpha.
 * @param {{ crop: number[], gradient: { top: string, bottom: string } }} asset
 * @param {string} [id]
 * @returns {import('./raster.js').Raster}
 * @throws {ArtProblem} `card-figure`, `card-cut-top`, `card-waist`
 */
export function cardOnGrid(master, { crop, gradient }, id) {
    const [left, top, width, height] = crop;
    const figure = opaqueBox(master);
    if (!figure) {
        throw new ArtProblem('card-figure', 'The card master has no opaque pixel, so there is no figure to put on the card.', { asset: id });
    }
    if (figure.y < top) {
        throw new ArtProblem('card-cut-top', `The figure starts at row ${figure.y} of the master, above the crop's first row ${top}, so the card would cut off its top.`, { asset: id });
    }
    const cut = renderFrame(master, { x: left, y: top, width, height });
    const shown = opaqueBox(cut);
    if (!shown || shown.y + shown.height !== height) {
        throw new ArtProblem('card-waist', `The crop's last row, row ${top + height - 1} of the master, does not cut the figure, which ends at row ${figure.y + figure.height - 1}. The card's bottom edge must cut the figure, as at the waist, or a band of gradient shows under it.`, { asset: id });
    }
    const card = createRaster(width, height, 3);
    for (let y = 0; y < height; y++) {
        const colour = [...gradientRow(gradient, y, height), 255];
        for (let x = 0; x < width; x++) {
            card.data.set(colour, (y * width + x) * 4);
        }
    }
    return paste(card, cut, 0, 0);
}

/**
 * The card text the card carries: the V3 card that the app's reader reads from the card file named by `text`, which for a
 * card the app already ships is the card file itself.
 * @param {{ root: string, id: string }} context
 * @param {{ text: string }} asset
 * @throws {ArtProblem} `card-text-missing`, `card-text-invalid`, `card-parser-missing`
 */
export async function cardTextOf({ root, id }, { text }) {
    const path = outputFile(root, text);
    if (!existsSync(path)) {
        throw new ArtProblem('card-text-missing', `The card text is read from ${text}, which does not exist.`, { asset: id, path: text });
    }
    const { read } = await loadAppCardParser();
    try {
        return JSON.parse(read(readFileSync(path)));
    } catch (error) {
        throw new ArtProblem('card-text-invalid', `${text} holds no card text that the app can read: ${error.message}`, { asset: id, path: text });
    }
}

/**
 * Makes the card file of a card entry in memory: the card on its grid, enlarged by the output's whole scale, with the card
 * text written by the app's writer and read back field by field. Nothing is written.
 * @param {{ root: string, id: string }} context
 * @param {any} asset A valid card entry.
 * @param {{ readMaster: (context: object, master: string) => Promise<import('./raster.js').Raster> }} reader Reads a native master.
 * @returns {Promise<import('./derive.js').DerivedFile[]>}
 */
export async function deriveCard(context, asset, { readMaster }) {
    const picture = cardOnGrid(await readMaster(context, asset.master), asset, context.id);
    const source = await cardTextOf(context, asset);
    const files = [];
    for (const output of asset.outputs) {
        const { png } = await buildCard({ master: picture, scale: output.scale ?? 1, source, world: asset.world });
        files.push({ path: output.path, bytes: png, sha256: sha256(png), kind: 'card' });
    }
    return files;
}

/**
 * Whether two card files carry the same card text: the same text chunks, keyword for keyword and byte for byte, in the
 * same order.
 * @param {Buffer} one
 * @param {Buffer} two
 */
export async function sameCardText(one, two) {
    const { extract, decodeText } = await loadAppCardParser();
    const texts = (png) => JSON.stringify(extract(new Uint8Array(png)).filter((chunk) => chunk.name === 'tEXt').map((chunk) => decodeText(chunk.data)));
    return texts(one) === texts(two);
}
