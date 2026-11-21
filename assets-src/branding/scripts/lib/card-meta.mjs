import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

// The card is written by the application's own writer, so the app reads it as a card it wrote itself: its V2 and V3 conversion, its chunk
// keywords and its chunk order. That file has no side effects when imported; its dependencies come from the repository's node_modules.
const APP_PARSER = fileURLToPath(new URL('../../../../src/character-card-parser.js', import.meta.url));
const V3 = { spec: 'chara_card_v3', spec_version: '3.0' };
const V2 = { spec: 'chara_card_v2', spec_version: '2.0' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The app's card writer and reader, and the PNG chunk reader it uses. Fails with the way out when the repository's packages are not installed. */
export async function loadAppCardParser() {
    try {
        const { read, write } = await import(APP_PARSER);
        const { default: extract } = await import('png-chunks-extract');
        const { default: PNGtext } = await import('png-chunk-text');
        return { read, write, extract, decodeText: PNGtext.decode };
    } catch (error) {
        throw new Error(`The application's card parser (${APP_PARSER}) could not be loaded: ${error.message}. Run "npm ci" in the repository root first.`);
    }
}

/**
 * The card to embed: the user's V3 card with the two edits the build is allowed to make, `data.extensions.world` set to `world` and
 * `data.character_book` removed. Nothing else is touched, so no character field changes; the source object is not changed.
 * @param {any} source the parsed card file
 * @param {string} world
 * @returns {{ card: any, edits: { path: string, change: 'set' | 'removed', from: unknown, to?: unknown }[] }}
 */
export function prepareCard(source, world) {
    if (!isObject(source) || source.spec !== V3.spec || source.spec_version !== V3.spec_version) {
        throw new Error(`The card file is not a V3 card: spec must be "${V3.spec}" and spec_version "${V3.spec_version}", got ${JSON.stringify(source?.spec)} and ${JSON.stringify(source?.spec_version)}.`);
    }
    if (!isObject(source.data) || typeof source.data.name !== 'string' || source.data.name === '') {
        throw new Error('The card file has no data.name, so it is not a card.');
    }
    if (source.data.extensions !== undefined && !isObject(source.data.extensions)) {
        throw new Error('data.extensions of the card file must be an object.');
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
 * Writes the card into a PNG with the app's writer: a `chara` chunk with the V2 card and a `ccv3` chunk with the V3 card, base64 of the
 * JSON, in the order the writer puts them before IEND.
 * @param {Buffer} png
 * @param {any} card
 */
export async function embedCard(png, card) {
    const { write } = await loadAppCardParser();
    return write(png, JSON.stringify(card));
}

/** The `[path, value]` of every leaf of a JSON value (an empty list or object counts as one), so two cards can be compared field by field. */
function leavesOf(value, path = '') {
    if (Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0) {
        return Object.entries(value).flatMap(([key, inner]) => leavesOf(inner, path ? `${path}.${key}` : key));
    }
    return [[path, value]];
}

/** The paths at which two cards differ, with both values; an empty list means every field is the same. Values are compared as the JSON they were written as. */
export function differences(expected, actual) {
    const wanted = new Map(leavesOf(expected));
    const found = new Map(leavesOf(actual));
    const paths = [...new Set([...wanted.keys(), ...found.keys()])];
    return paths
        .filter((path) => !(wanted.has(path) && found.has(path) && JSON.stringify(wanted.get(path)) === JSON.stringify(found.get(path))))
        .map((path) => ({ path, expected: wanted.get(path), actual: found.get(path) }));
}

/**
 * Reads a built card back the way the app does and compares it with the card that was meant to go in: the text chunks are exactly `chara` and
 * `ccv3`; the V3 card the app's reader returns (it prefers `ccv3`) is the card field for field; the `chara` chunk is the same card as V2, field
 * for field except the spec and its version; and `world` is set with no `character_book`. It throws with every difference it finds.
 * @param {Buffer} png
 * @param {any} card the card as it should be read back
 * @param {string} world
 * @returns {Promise<{ chunks: string[], fields: number, v3: any, v2: any }>}
 */
export async function verifyCard(png, card, world) {
    const { read, extract, decodeText } = await loadAppCardParser();
    const texts = extract(new Uint8Array(png)).filter((chunk) => chunk.name === 'tEXt').map((chunk) => decodeText(chunk.data));
    const chunks = texts.map(({ keyword }) => keyword);
    const problems = [];
    if (chunks.length !== 2 || !chunks.includes('chara') || !chunks.includes('ccv3')) {
        problems.push(`the text chunks are [${chunks.join(', ')}], not "chara" and "ccv3"`);
    }
    const v3 = JSON.parse(read(png));
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
        throw new Error(`The built card does not read back as the card it was made from:\n  ${problems.join('\n  ')}`);
    }
    return { chunks, fields: leavesOf(card).length, v3, v2 };
}
