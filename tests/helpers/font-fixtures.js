import zlib from 'node:zlib';

/**
 * Fonts built from bytes, so no test downloads a font. `buildTrueTypeFont` writes the smallest TrueType file that a browser's
 * font sanitiser accepts (one empty glyph), with the name, OS/2 and head fields a test wants to read back. The WOFF and WOFF2
 * wrappers pack the same tables.
 */

const u16 = value => Buffer.from([(value >> 8) & 0xff, value & 0xff]);
const u32 = value => Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const i16 = value => u16(value & 0xffff);
const tag = text => Buffer.from(text, 'latin1');
const pad4 = buffer => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4)]);

function checksum(buffer) {
    const padded = pad4(buffer);
    let sum = 0;
    for (let offset = 0; offset < padded.length; offset += 4) sum = (sum + padded.readUInt32BE(offset)) >>> 0;
    return sum;
}

function nameTable(strings, platform = 3) {
    const records = Object.entries(strings).map(([id, text]) => ({ id: Number(id), data: platform === 1 ? Buffer.from(text, 'latin1') : Buffer.from(text, 'utf16le').swap16() }));
    let offset = 0;
    const header = Buffer.concat([u16(0), u16(records.length), u16(6 + records.length * 12)]);
    const entries = records.map(record => {
        const entry = Buffer.concat([u16(platform), u16(platform === 1 ? 0 : 1), u16(platform === 1 ? 0 : 0x409), u16(record.id), u16(record.data.length), u16(offset)]);
        offset += record.data.length;
        return entry;
    });
    return Buffer.concat([header, ...entries, ...records.map(record => record.data)]);
}

/** One simple glyph, a triangle: a browser's font sanitiser refuses a glyf table with no data. */
function triangleGlyph() {
    return pad4(Buffer.concat([i16(1), i16(0), i16(0), i16(100), i16(100), u16(2), u16(0), Buffer.from([1, 1, 1]), i16(0), i16(100), i16(-100), i16(0), i16(0), i16(100)]));
}

function headTable({ italic }) {
    return Buffer.concat([
        u32(0x00010000), u32(0x00010000), u32(0), u32(0x5f0f3cf5), u16(0), u16(1000),
        Buffer.alloc(16), // created and modified
        i16(0), i16(0), i16(100), i16(100), // bounding box
        u16(italic ? 2 : 0), u16(8), i16(2), i16(0), i16(0),
    ]);
}

function os2Table({ weight, italic }) {
    const table = Buffer.alloc(96);
    table.writeUInt16BE(4, 0);
    table.writeUInt16BE(weight, 4);
    table.writeUInt16BE(5, 6);
    table.writeUInt16BE(italic ? 0x0001 | 0x0040 : 0x0040, 62);
    table.writeUInt16BE(0x20, 64);
    table.writeUInt16BE(0xffff, 66);
    table.writeInt16BE(800, 68);
    table.writeInt16BE(-200, 70);
    table.writeUInt16BE(800, 74);
    table.writeUInt16BE(200, 76);
    return table;
}

function cmapTable() {
    const subtable = Buffer.concat([u16(4), u16(24), u16(0), u16(2), u16(2), u16(0), u16(0), u16(0xffff), u16(0), u16(0xffff), u16(1), u16(0)]);
    return Buffer.concat([u16(0), u16(1), u16(3), u16(1), u32(12), subtable]);
}

/**
 * A variable-font axis table with one `wght` axis.
 * @param {number} low
 * @param {number} high
 */
export function fvarTable(low, high) {
    const axis = Buffer.concat([tag('wght'), u32(low * 65536), u32(400 * 65536), u32(high * 65536), u16(0), u16(256)]);
    return Buffer.concat([u16(1), u16(0), u16(16), u16(2), u16(1), u16(20), u16(0), u16(0), axis]);
}

/**
 * @param {object} [options]
 * @param {string} [options.family]  Name ID 1 (and 16 when `typographic` is set).
 * @param {string} [options.subfamily]
 * @param {number} [options.weight]  `usWeightClass`.
 * @param {boolean} [options.italic]
 * @param {boolean} [options.typographic]  Writes name IDs 16 and 17 as well, with `family` as the typographic family and `legacyFamily` as ID 1.
 * @param {string} [options.legacyFamily]
 * @param {1|2|3} [options.platform]  Platform of the name records: 3 (Windows), 1 (Macintosh) or 2 (ISO, which the reader skips).
 * @param {boolean} [options.omitName]
 * @param {boolean} [options.omitOs2]
 * @param {Buffer} [options.fvar]
 * @param {'ttf'|'otf'} [options.flavor]  `otf` only changes the first four bytes; the file is not a real CFF font.
 * @returns {{ tables: Map<string, Buffer>, build: () => Buffer }}
 */
export function buildFontTables({ family = 'Test Face', subfamily = 'Regular', weight = 400, italic = false, typographic = false, legacyFamily, platform = 3, omitName = false, omitOs2 = false, fvar } = {}) {
    const strings = typographic
        ? { 1: legacyFamily ?? `${family} ${subfamily}`, 2: subfamily, 4: `${family} ${subfamily}`, 6: `${family}-${subfamily}`.replace(/ /g, ''), 16: family, 17: subfamily }
        : { 1: family, 2: subfamily, 4: `${family} ${subfamily}`, 6: `${family}-${subfamily}`.replace(/ /g, '') };
    const tables = new Map([
        ['cmap', cmapTable()],
        ['glyf', triangleGlyph()],
        ['head', headTable({ italic })],
        ['hhea', Buffer.concat([u32(0x00010000), i16(800), i16(-200), i16(0), u16(500), i16(0), i16(0), i16(0), i16(1), i16(0), i16(0), Buffer.alloc(8), i16(0), u16(1)])],
        ['hmtx', Buffer.concat([u16(500), i16(0)])],
        ['loca', Buffer.concat([u16(0), u16(triangleGlyph().length / 2)])],
        ['maxp', Buffer.concat([u32(0x00010000), u16(1), u16(3), u16(1), u16(0), u16(0), u16(1), Buffer.alloc(16)])],
        ['post', Buffer.concat([u32(0x00030000), Buffer.alloc(28)])],
    ]);
    if (!omitName) tables.set('name', nameTable(strings, platform));
    if (!omitOs2) tables.set('OS/2', os2Table({ weight, italic }));
    if (fvar) tables.set('fvar', fvar);
    return { tables, build: () => buildSfnt(tables) };
}

/** Packs tables into an sfnt file. `signature` replaces the first four bytes (for `OTTO`, `true` and `ttcf` cases). */
export function buildSfnt(tables, signature = Buffer.from([0, 1, 0, 0])) {
    const sorted = [...tables.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const count = sorted.length;
    let offset = 12 + count * 16;
    const directory = [];
    const bodies = [];
    for (const [name, data] of sorted) {
        directory.push(Buffer.concat([tag(name), u32(checksum(data)), u32(offset), u32(data.length)]));
        const padded = pad4(data);
        bodies.push(padded);
        offset += padded.length;
    }
    const entrySelector = Math.floor(Math.log2(count));
    const searchRange = 2 ** entrySelector * 16;
    const file = Buffer.concat([signature, u16(count), u16(searchRange), u16(entrySelector), u16(count * 16 - searchRange), ...directory, ...bodies]);
    const headRecord = sorted.findIndex(([name]) => name === 'head');
    if (headRecord >= 0) {
        const headOffset = file.readUInt32BE(12 + headRecord * 16 + 8);
        file.writeUInt32BE(0, headOffset + 8);
        file.writeUInt32BE((0xb1b0afba - checksum(file)) >>> 0, headOffset + 8);
    }
    return file;
}

/** A WOFF file around the tables. Tables that shrink are stored deflated, as the format wants. */
export function buildWoff(tables, { flavor = Buffer.from([0, 1, 0, 0]), originalLengthOverride } = {}) {
    const sorted = [...tables.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    let offset = 44 + sorted.length * 20;
    const directory = [];
    const bodies = [];
    for (const [name, data] of sorted) {
        const deflated = zlib.deflateSync(data);
        const stored = deflated.length < data.length ? deflated : data;
        const declared = originalLengthOverride?.[name] ?? data.length;
        directory.push(Buffer.concat([tag(name), u32(offset), u32(stored.length), u32(declared), u32(checksum(data))]));
        const padded = pad4(stored);
        bodies.push(padded);
        offset += padded.length;
    }
    const header = Buffer.concat([tag('wOFF'), flavor, u32(offset), u16(sorted.length), u16(0), u32(0), u16(1), u16(0), u32(0), u32(0), u32(0), u32(0), u32(0)]);
    return Buffer.concat([header, ...directory, ...bodies]);
}

const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post'];

function base128(value) {
    const bytes = [value & 0x7f];
    for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80);
    return Buffer.from(bytes);
}

/**
 * A WOFF2 file whose tables are all stored untransformed. It has no `glyf`, so it is only good for the metadata reader.
 * @param {Map<string, Buffer>} tables
 */
export function buildWoff2(tables) {
    const kept = [...tables.entries()].filter(([name]) => name !== 'glyf' && name !== 'loca').sort(([a], [b]) => (a < b ? -1 : 1));
    const directory = Buffer.concat(kept.map(([name, data]) => {
        const index = WOFF2_TAGS.indexOf(name);
        return index >= 0
            ? Buffer.concat([Buffer.from([index]), base128(data.length)])
            : Buffer.concat([Buffer.from([0x3f]), tag(name), base128(data.length)]);
    }));
    const stream = zlib.brotliCompressSync(Buffer.concat(kept.map(([, data]) => data)));
    const header = Buffer.concat([tag('wOF2'), Buffer.from([0, 1, 0, 0]), u32(48 + directory.length + stream.length), u16(kept.length), u16(0), u32(0), u32(stream.length), u16(1), u16(0), u32(0), u32(0), u32(0), u32(0), u32(0)]);
    return Buffer.concat([header, directory, stream]);
}

/** A file of `size` bytes that starts with `signature`, for the extension and magic byte checks. */
export const withSignature = (signature, size = 64) => Buffer.concat([Buffer.from(signature, 'latin1'), Buffer.alloc(Math.max(0, size - signature.length))]);
