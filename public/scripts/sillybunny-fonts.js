import { t } from './i18n.js';

/**
 * Font Settings: importing font files, the bundled presets and the legacy Google Fonts name.
 *
 * This module loads on demand (a saved font, a saved import, or a use of the Font group). It never reaches
 * `power-user.js` itself: the caller passes a `host` that owns the settings, so the code here stays testable and the
 * startup module graph does not grow.
 *
 * @typedef {object} FontEntry
 * @property {string} id
 * @property {string} family
 * @property {string} file  Path the upload route returned, for example `/user/files/sb-font-0123456789ab.woff2`.
 * @property {number|string} weight  A weight, or a range such as `'100 900'`.
 * @property {'normal'|'italic'} style
 * @property {'woff2'|'woff'|'truetype'|'opentype'} format
 *
 * @typedef {object} FontHost
 * @property {() => FontEntry[]} getFonts
 * @property {(fonts: FontEntry[]) => void} setFonts
 * @property {() => string} getChoice
 * @property {(name: string) => void} setChoice
 * @property {() => void} save
 * @property {() => void} apply  Applies the saved choice again.
 * @property {() => Record<string, string>} getRequestHeaders
 * @property {() => string} uuid
 */

export const FONT_FILE_PREFIX = 'sb-font-';
export const MAX_FONT_BYTES = 5 * 1024 * 1024;
export const MAX_FONT_FILES = 20;
export const MAX_FONT_FAMILIES = 20;
export const MAX_FAMILY_LENGTH = 64;
/** The most a name, OS/2 or fvar table may inflate to. A WOFF table declares its own size, so it is capped before inflating. */
export const MAX_TABLE_BYTES = 1024 * 1024;
/** The most a WOFF2 stream may inflate to; the whole font is one stream. */
const MAX_WOFF2_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TABLES = 256;

export const IMPORT_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';
export const PRESET_STYLE_ID = 'sb-preset-font-style';
export const IMPORTED_STYLE_ID = 'sb-imported-fonts';
export const GOOGLE_STYLE_ID = 'google-font-style';
/** Key of the preset stylesheet links; the files themselves are versioned by their own stylesheets. */
export const PRESET_STYLESHEET_KEY = '20261118q';
export const FONT_STACK_TAIL = '\'Adwaita Sans\', system-ui, sans-serif';

/** The bundled presets: the name that `google_font` stores and the folder under `public/webfonts/`. */
export const FONT_PRESETS = Object.freeze([
    Object.freeze({ name: 'Inter', directory: 'Inter' }),
    Object.freeze({ name: 'JetBrains Mono', directory: 'JetBrainsMono' }),
    Object.freeze({ name: 'Roboto', directory: 'Roboto' }),
    Object.freeze({ name: 'Public Sans', directory: 'PublicSans' }),
    Object.freeze({ name: 'Source Serif 4', directory: 'SourceSerif4' }),
]);

const FORMAT_BY_EXTENSION = Object.freeze({ woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' });
const FILE_PATH_PATTERN = new RegExp(`^/?user/files/${FONT_FILE_PREFIX}[0-9a-f]{12}\\.(woff2|woff|ttf|otf)$`);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const WEIGHT_RANGE_PATTERN = /^(\d{1,4}) (\d{1,4})$/;
/** C0 and C1 controls, line and paragraph separators, and the bidirectional controls. */
const UNWANTED_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// ---------------------------------------------------------------------------------------------------------------------
// Names, the settings list and the CSS that is built from them
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A family name that is safe to keep: no controls, one space between words, at most `MAX_FAMILY_LENGTH` characters.
 * @param {unknown} value
 * @returns {string} The name, or an empty string when nothing is left.
 */
export function sanitizeFamilyName(value) {
    return String(value ?? '').replace(UNWANTED_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FAMILY_LENGTH).trim();
}

/**
 * A CSS string literal. Every character that could end the string, start a block or open a tag is written as a code point
 * escape, so a family name cannot inject a rule even when a caller forgets to sanitise it.
 * @param {unknown} value
 * @returns {string} The literal, with its single quotes.
 */
export function cssString(value) {
    const escaped = String(value ?? '').replace(/[^A-Za-z0-9 _.,()+-]/gu, character => `\\${character.codePointAt(0).toString(16)} `);
    return `'${escaped}'`;
}

/** The `--mainFontFamily` value for a chosen family. */
export function buildFontStack(name) {
    return `${cssString(name)}, ${FONT_STACK_TAIL}`;
}

/** @returns {number|string|null} The weight when it is one number from 1 to 1000 or a range of two, else null. */
export function normalizeWeight(value) {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d{1,4}$/.test(value.trim()))) {
        const weight = Number(value);
        return Number.isInteger(weight) && weight >= 1 && weight <= 1000 ? weight : null;
    }
    const range = typeof value === 'string' ? WEIGHT_RANGE_PATTERN.exec(value.trim()) : null;
    if (!range) return null;
    const [low, high] = [Number(range[1]), Number(range[2])];
    return low >= 1 && high <= 1000 && low < high ? `${low} ${high}` : null;
}

/**
 * Reads the saved list the way `sb_folders` is read: anything that is not a well-formed entry is dropped, so a hand edited or
 * foreign settings file can never reach the style sheet or a delete request.
 * @param {unknown} value
 * @returns {FontEntry[]}
 */
export function normalizeFonts(value) {
    if (!Array.isArray(value)) return [];
    const seenIds = new Set();
    const seenFiles = new Set();
    const result = [];
    for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue;
        const family = sanitizeFamilyName(raw.family);
        const weight = normalizeWeight(raw.weight);
        const file = typeof raw.file === 'string' ? raw.file : '';
        const extension = FILE_PATH_PATTERN.exec(file)?.[1];
        const format = FORMAT_BY_EXTENSION[extension];
        if (!family || weight === null || !format || !ID_PATTERN.test(String(raw.id ?? ''))) continue;
        if (raw.style !== 'normal' && raw.style !== 'italic') continue;
        if (seenIds.has(raw.id) || seenFiles.has(file)) continue;
        seenIds.add(raw.id);
        seenFiles.add(file);
        result.push({ id: raw.id, family, file, weight, style: raw.style, format });
        if (result.length >= MAX_FONT_FILES) break;
    }
    return result;
}

/** @returns {string[]} The imported family names, each once, in alphabetical order. */
export function listImportedFamilies(fonts) {
    return [...new Set(fonts.map(font => font.family))].sort((a, b) => a.localeCompare(b));
}

/** The URL a saved entry is served from, built from the validated path only. */
export function fontUrl(entry) {
    return `/${entry.file.replace(/^\/+/, '')}`;
}

/** @param {FontEntry[]} fonts */
export function buildFontFaceRules(fonts) {
    return normalizeFonts(fonts).map(entry => `@font-face{font-family:${cssString(entry.family)};src:url(${cssString(fontUrl(entry))}) format(${cssString(entry.format)});font-weight:${entry.weight};font-style:${entry.style};font-display:swap}`).join('\n');
}

const sameName = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The name a stored choice should have. Google treated `inter` and `Public  Sans` as the families `Inter` and `Public Sans`, so a
 * name that differs from an imported family or a preset only by case or by spacing becomes that family's own name. Any other
 * name is returned as it was.
 * @param {unknown} name
 * @param {FontEntry[]} fonts
 */
export function canonicalFontName(name, fonts) {
    const text = String(name ?? '').trim();
    if (!text) return '';
    const known = [...listImportedFamilies(fonts), ...FONT_PRESETS.map(preset => preset.name)];
    return known.find(candidate => candidate === text) ?? known.find(candidate => sameName(candidate, text)) ?? text;
}

/**
 * The three steps that decide where a family comes from: an imported family, then a bundled preset (exact name), then the
 * legacy Google Fonts name.
 * @param {unknown} name
 * @param {FontEntry[]} fonts
 * @returns {{ kind: 'none'|'imported'|'preset'|'google', name: string, preset?: { name: string, directory: string } }}
 */
export function resolveFont(name, fonts) {
    const text = String(name ?? '').trim();
    if (!text) return { kind: 'none', name: '' };
    if (fonts.some(font => font.family === text)) return { kind: 'imported', name: text };
    const preset = FONT_PRESETS.find(candidate => candidate.name === text);
    if (preset) return { kind: 'preset', name: text, preset };
    return { kind: 'google', name: text };
}

/** The href of the Google stylesheet for a legacy name. */
export function buildGoogleFontHref(name) {
    const family = String(name ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
    return family ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;500;600;700&display=swap` : '';
}

/** The href of a preset's stylesheet. */
export function buildPresetHref(preset) {
    return `webfonts/${preset.directory}/stylesheet.css?v=${PRESET_STYLESHEET_KEY}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Files: extension, size and magic bytes
// ---------------------------------------------------------------------------------------------------------------------

/** @returns {string} The lower-case extension without its dot, or an empty string. */
export function extensionOf(fileName) {
    const match = /\.([A-Za-z0-9]+)$/.exec(String(fileName ?? ''));
    return match ? match[1].toLowerCase() : '';
}

/**
 * The container a file starts as, by its first four bytes.
 * @param {Uint8Array} bytes
 * @returns {'woff2'|'woff'|'truetype'|'opentype'|'collection'|null}
 */
export function sniffContainer(bytes) {
    if (!bytes || bytes.length < 4) return null;
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (tag === 'wOF2') return 'woff2';
    if (tag === 'wOFF') return 'woff';
    if (tag === 'OTTO') return 'opentype';
    if (tag === 'ttcf') return 'collection';
    if (tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'truetype';
    return null;
}

/**
 * Checks a file before anything is read from it or sent anywhere.
 * @param {{ name: string, size: number }} file
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, extension: string, format: 'woff2'|'woff'|'truetype'|'opentype' } | { ok: false, reason: 'extension'|'empty'|'size'|'collection'|'signature'|'mismatch' }}
 */
export function validateFontFile(file, bytes) {
    const extension = extensionOf(file.name);
    if (!Object.hasOwn(FORMAT_BY_EXTENSION, extension)) return { ok: false, reason: 'extension' };
    if (!file.size || !bytes?.length) return { ok: false, reason: 'empty' };
    if (file.size > MAX_FONT_BYTES || bytes.length > MAX_FONT_BYTES) return { ok: false, reason: 'size' };
    const container = sniffContainer(bytes);
    if (container === 'collection') return { ok: false, reason: 'collection' };
    if (!container) return { ok: false, reason: 'signature' };
    if (container !== FORMAT_BY_EXTENSION[extension]) return { ok: false, reason: 'mismatch' };
    return { ok: true, extension, format: container };
}

// ---------------------------------------------------------------------------------------------------------------------
// The table reader: name, OS/2, head and fvar of TTF, OTF, WOFF and (where the browser has Brotli) WOFF2
// ---------------------------------------------------------------------------------------------------------------------

const WANTED_TABLES = new Set(['name', 'OS/2', 'head', 'fvar']);

/** The WOFF2 table directory's known tags, by index (the WOFF2 specification, section 5.1). */
export const WOFF2_KNOWN_TAGS = Object.freeze([
    'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
    'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
    'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
    'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
]);

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tagAt = (view, offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

/** Inflates `data`, giving up as soon as the output passes `limit` bytes. Returns null on any failure. */
async function inflate(data, format, limit) {
    try {
        const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > limit) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        return output;
    } catch {
        return null;
    }
}

/** @returns {boolean} Whether this browser can inflate Brotli, which a WOFF2 file needs before any table can be read. */
export function canReadWoff2() {
    try {
        new DecompressionStream('brotli');
        return true;
    } catch {
        return false;
    }
}

/** @returns {Map<string, Uint8Array>|null} The wanted tables, or null when the file is malformed. */
function readSfntTables(bytes) {
    if (bytes.length < 12) return null;
    const view = viewOf(bytes);
    const count = view.getUint16(4);
    if (!count || count > MAX_TABLES || 12 + count * 16 > bytes.length) return null;
    const tables = new Map();
    for (let index = 0; index < count; index++) {
        const record = 12 + index * 16;
        const tag = tagAt(view, record);
        if (!WANTED_TABLES.has(tag)) continue;
        const offset = view.getUint32(record + 8);
        const length = view.getUint32(record + 12);
        if (length > MAX_TABLE_BYTES || offset > bytes.length || length > bytes.length - offset) return null;
        tables.set(tag, bytes.subarray(offset, offset + length));
    }
    return tables;
}

async function readWoffTables(bytes) {
    if (bytes.length < 44) return null;
    const view = viewOf(bytes);
    const count = view.getUint16(12);
    if (!count || count > MAX_TABLES || 44 + count * 20 > bytes.length) return null;
    const tables = new Map();
    for (let index = 0; index < count; index++) {
        const record = 44 + index * 20;
        const tag = tagAt(view, record);
        if (!WANTED_TABLES.has(tag)) continue;
        const offset = view.getUint32(record + 4);
        const compressed = view.getUint32(record + 8);
        const original = view.getUint32(record + 12);
        if (original > MAX_TABLE_BYTES || compressed > original || offset > bytes.length || compressed > bytes.length - offset) return null;
        const stored = bytes.subarray(offset, offset + compressed);
        if (compressed === original) {
            tables.set(tag, stored);
            continue;
        }
        const table = await inflate(stored, 'deflate', original);
        if (!table || table.length !== original) return null;
        tables.set(tag, table);
    }
    return tables;
}

/** A WOFF2 variable-length unsigned integer: at most five bytes, no leading zero byte, no overflow. */
function readBase128(bytes, start) {
    let value = 0;
    for (let index = 0; index < 5; index++) {
        const byte = bytes[start + index];
        if (byte === undefined || (index === 0 && byte === 0x80) || value > 0x1fffffff) return null;
        value = value * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) return { value, next: start + index + 1 };
    }
    return null;
}

async function readWoff2Tables(bytes) {
    if (bytes.length < 48 || !canReadWoff2()) return null;
    const view = viewOf(bytes);
    if (tagAt(view, 4) === 'ttcf') return null;
    const count = view.getUint16(12);
    const compressedSize = view.getUint32(20);
    if (!count || count > MAX_TABLES) return null;
    const directory = [];
    let cursor = 48;
    let streamSize = 0;
    for (let index = 0; index < count; index++) {
        const flags = bytes[cursor++];
        if (flags === undefined) return null;
        let tag = WOFF2_KNOWN_TAGS[flags & 0x3f];
        if ((flags & 0x3f) === 0x3f) {
            if (cursor + 4 > bytes.length) return null;
            tag = tagAt(view, cursor);
            cursor += 4;
        }
        const original = readBase128(bytes, cursor);
        if (!original) return null;
        cursor = original.next;
        const transform = flags >> 6;
        const transformed = tag === 'glyf' || tag === 'loca' ? transform === 0 : transform !== 0;
        let size = original.value;
        if (transformed) {
            const length = readBase128(bytes, cursor);
            if (!length) return null;
            cursor = length.next;
            size = length.value;
        }
        streamSize += size;
        if (streamSize > MAX_WOFF2_STREAM_BYTES) return null;
        directory.push({ tag, size, transformed });
    }
    if (compressedSize > bytes.length - cursor) return null;
    const stream = await inflate(bytes.subarray(cursor, cursor + compressedSize), 'brotli', streamSize);
    if (!stream || stream.length !== streamSize) return null;
    const tables = new Map();
    let offset = 0;
    for (const entry of directory) {
        if (WANTED_TABLES.has(entry.tag)) {
            if (entry.transformed || entry.size > MAX_TABLE_BYTES) return null;
            tables.set(entry.tag, stream.subarray(offset, offset + entry.size));
        }
        offset += entry.size;
    }
    return tables;
}

/** Decodes a name record's string. Platform 3 and 0 are UTF-16BE; platform 1 is Mac Roman. */
function decodeName(bytes, platform) {
    try {
        return new TextDecoder(platform === 1 ? 'macintosh' : 'utf-16be').decode(bytes);
    } catch {
        return '';
    }
}

/** The best string for a name ID: Windows English, then any Windows, then Unicode, then Macintosh. */
function readNameString(table, wantedId) {
    if (table.length < 6) return '';
    const view = viewOf(table);
    const count = view.getUint16(2);
    const storage = view.getUint16(4);
    let best = null;
    for (let index = 0; index < count; index++) {
        const record = 6 + index * 12;
        if (record + 12 > table.length) break;
        if (view.getUint16(record + 6) !== wantedId) continue;
        const platform = view.getUint16(record);
        const language = view.getUint16(record + 4);
        const length = view.getUint16(record + 8);
        const offset = storage + view.getUint16(record + 10);
        if (offset + length > table.length) continue;
        const rank = platform === 3 ? (language === 0x409 ? 0 : 1) : platform === 0 ? 2 : platform === 1 ? 3 : 9;
        if (rank < 9 && (!best || rank < best.rank)) best = { rank, platform, offset, length };
    }
    return best ? sanitizeFamilyName(decodeName(table.subarray(best.offset, best.offset + best.length), best.platform)) : '';
}

/** The `wght` axis of an fvar table as a range, or null when there is none or it does not vary. */
function readWeightAxis(table) {
    if (!table || table.length < 16) return null;
    const view = viewOf(table);
    const axesOffset = view.getUint16(4);
    const axisCount = view.getUint16(8);
    const axisSize = view.getUint16(10);
    if (axisSize < 20 || axisCount > 64) return null;
    for (let index = 0; index < axisCount; index++) {
        const record = axesOffset + index * axisSize;
        if (record + 20 > table.length) return null;
        if (tagAt(view, record) !== 'wght') continue;
        const low = Math.round(view.getInt32(record + 4) / 65536);
        const high = Math.round(view.getInt32(record + 12) / 65536);
        return normalizeWeight(`${low} ${high}`);
    }
    return null;
}

/**
 * Reads the family, weight and style that a font file declares.
 * @param {Uint8Array} bytes  A file that `validateFontFile` accepted.
 * @returns {Promise<{ family: string, weight: number|string, style: 'normal'|'italic' }|null>} Null when the family cannot be read
 *     (a WOFF2 file in a browser without Brotli, a missing name table, a malformed file). The caller then asks the user.
 */
export async function readFontMetadata(bytes) {
    const container = sniffContainer(bytes);
    let tables = null;
    try {
        if (container === 'truetype' || container === 'opentype') tables = readSfntTables(bytes);
        else if (container === 'woff') tables = await readWoffTables(bytes);
        else if (container === 'woff2') tables = await readWoff2Tables(bytes);
    } catch {
        tables = null;
    }
    const name = tables?.get('name');
    if (!name) return null;
    const family = readNameString(name, 16) || readNameString(name, 1);
    if (!family) return null;

    const os2 = tables.get('OS/2');
    const head = tables.get('head');
    let weight = 400;
    let italic = false;
    if (os2 && os2.length >= 64) {
        const view = viewOf(os2);
        const weightClass = view.getUint16(4);
        weight = weightClass >= 1 && weightClass <= 1000 ? weightClass : 400;
        const selection = view.getUint16(62);
        italic = Boolean(selection & 0x01) || Boolean(selection & 0x200);
    } else if (head && head.length >= 46) {
        italic = Boolean(viewOf(head).getUint16(44) & 0x02);
    }
    return { family, weight: readWeightAxis(tables.get('fvar')) ?? weight, style: italic ? 'italic' : 'normal' };
}

const WEIGHT_WORDS = [
    ['extralight', 200], ['ultralight', 200], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800],
    ['thin', 100], ['hairline', 100], ['light', 300], ['regular', 400], ['normal', 400], ['book', 400], ['medium', 500],
    ['bold', 700], ['black', 900], ['heavy', 900],
];

/**
 * What the file name suggests, to start the naming dialog from: `Inter-BoldItalic.woff2` gives Inter, 700, italic.
 * @param {string} fileName
 * @returns {{ family: string, weight: number|string, style: 'normal'|'italic' }}
 */
export function guessFromFileName(fileName) {
    let stem = String(fileName ?? '').replace(/\.[A-Za-z0-9]+$/, '').replace(/\[[^\]]*\]/g, '');
    const variable = /variable/i.test(stem);
    stem = stem.replace(/variable/gi, '');
    const split = stem.search(/[-_ ]/);
    const familyPart = split > 0 ? stem.slice(0, split) : stem;
    const stylePart = (split > 0 ? stem.slice(split + 1) : '').toLowerCase();
    let weight = 400;
    for (const [word, value] of WEIGHT_WORDS) {
        if (stylePart.includes(word)) {
            weight = value;
            break;
        }
    }
    const italic = /italic|oblique/.test(stylePart);
    return { family: sanitizeFamilyName(familyPart.replace(/[-_]+/g, ' ')), weight: variable ? '100 900' : weight, style: italic ? 'italic' : 'normal' };
}

// ---------------------------------------------------------------------------------------------------------------------
// The page: styles, the select and the choice
// ---------------------------------------------------------------------------------------------------------------------

/** Writes (or removes) the one style element that holds the imported faces. A face is fetched only when text uses it. */
export function applyImportedFaces(fonts, doc = document) {
    const rules = buildFontFaceRules(fonts);
    let style = doc.getElementById(IMPORTED_STYLE_ID);
    if (!rules) {
        style?.remove();
        return;
    }
    if (!style) {
        style = doc.createElement('style');
        style.id = IMPORTED_STYLE_ID;
        doc.head.append(style);
    }
    if (style.textContent !== rules) style.textContent = rules;
}

function setLink(doc, id, href) {
    let link = doc.getElementById(id);
    if (!href) {
        link?.remove();
        return;
    }
    if (!link) {
        link = doc.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        doc.head.append(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

/**
 * Applies a choice: the faces, the stylesheet it needs and `--mainFontFamily`. With no name the theme's own font returns.
 * @param {string} name
 * @param {{ fonts: FontEntry[], themeFont?: string, doc?: Document }} options
 * @returns {ReturnType<typeof resolveFont>}
 */
export function applyFontChoice(name, { fonts, themeFont = '', doc = document }) {
    const resolved = resolveFont(name, fonts);
    const root = doc.documentElement.style;
    applyImportedFaces(fonts, doc);
    setLink(doc, GOOGLE_STYLE_ID, resolved.kind === 'google' ? buildGoogleFontHref(resolved.name) : '');
    setLink(doc, PRESET_STYLE_ID, resolved.kind === 'preset' ? buildPresetHref(resolved.preset) : '');
    if (resolved.kind === 'none') {
        if (themeFont) root.setProperty('--mainFontFamily', themeFont);
        else root.removeProperty('--mainFontFamily');
    } else {
        root.setProperty('--mainFontFamily', buildFontStack(resolved.name));
    }
    return resolved;
}

/**
 * Rebuilds the options of the font select: Default, Presets, Imported and, only while a legacy name is the choice, Google Fonts.
 * The select stays the source of truth for the row built over it.
 * @param {HTMLSelectElement|null} select
 * @param {{ fonts: FontEntry[], choice: string }} state
 */
export function syncFontSelect(select, { fonts, choice }) {
    if (!(select instanceof HTMLSelectElement)) return;
    const resolved = resolveFont(choice, fonts);
    const doc = select.ownerDocument;
    const option = (value, kind) => {
        const node = doc.createElement('option');
        node.value = value;
        node.textContent = value;
        node.dataset.sbFontKind = kind;
        return node;
    };
    const group = (label, kind, names) => {
        if (!names.length) return [];
        const node = doc.createElement('optgroup');
        node.label = label;
        node.append(...names.map(name => option(name, kind)));
        return [node];
    };
    const none = doc.createElement('option');
    none.value = '';
    none.textContent = t`Default (none)`;
    const next = [
        none,
        ...group(t`Presets`, 'preset', FONT_PRESETS.map(preset => preset.name)),
        ...group(t`Imported`, 'imported', listImportedFamilies(fonts)),
        ...group(t`Google Fonts`, 'google', resolved.kind === 'google' ? [resolved.name] : []),
    ];
    const signature = nodes => nodes.map(node => `${node.tagName}:${node.label ?? ''}${node.value ?? ''}${[...node.children ?? []].map(child => child.value).join(',')}`).join('|');
    if (signature([...select.children]) !== signature(next)) select.replaceChildren(...next);
    select.value = resolved.name;
    select.dataset.sbFontSource = resolved.kind;
}

// ---------------------------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------------------------

function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

async function uploadFont(host, name, bytes) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: host.getRequestHeaders(),
        body: JSON.stringify({ name, data: toBase64(bytes) }),
    });
    if (!response.ok) throw new Error(await response.text());
    const { path } = await response.json();
    return String(path ?? '');
}

/**
 * Deletes a stored font file. Only a path from a normalised entry is sent. A 404 counts as done, because the file is gone.
 * @returns {Promise<boolean>}
 */
export async function deleteFontFile(host, entry) {
    if (!FILE_PATH_PATTERN.test(entry.file)) return false;
    try {
        const response = await fetch('/api/files/delete', {
            method: 'POST',
            headers: host.getRequestHeaders(),
            body: JSON.stringify({ path: entry.file }),
        });
        return response.ok || response.status === 404;
    } catch {
        return false;
    }
}

/** The browser must accept the font before it is stored; the same check registers nothing in the page. */
async function browserAccepts(family, bytes, { weight, style }) {
    try {
        await new FontFace(cssString(family), bytes.slice().buffer, { weight: String(weight), style }).load();
        return true;
    } catch {
        return false;
    }
}

const WEIGHT_CHOICES = [100, 200, 300, 400, 500, 600, 700, 800, 900, '100 900'];

/**
 * Asks for the family, weight and style of a file whose family could not be read.
 * @param {{ fileName: string, suggestion?: { family: string, weight: number|string, style: 'normal'|'italic' } }} options
 * @returns {Promise<{ family: string, weight: number|string, style: 'normal'|'italic' }|null>} Null when the user cancels.
 */
export async function openFontNamingDialog({ fileName, suggestion = guessFromFileName(fileName) }) {
    const [{ openDialog }, { createEntryRow, createPrefGroup }, { createSelectRow }, { createToggleRow }] = await Promise.all([
        import('./sillybunny-editor/dialog.js'),
        import('./sillybunny-editor/rows.js'),
        import('./sillybunny-editor/select-row.js'),
        import('./sillybunny-editor/toggle-row.js'),
    ]);

    const family = createEntryRow({ label: t`Family`, field: 'font-family', value: suggestion.family, maxLength: MAX_FAMILY_LENGTH, floating: true });
    const weightSelect = document.createElement('select');
    weightSelect.id = 'sb_font_weight';
    for (const weight of WEIGHT_CHOICES) {
        const option = document.createElement('option');
        option.value = String(weight);
        option.textContent = String(weight).replace(' ', '\u2013');
        weightSelect.append(option);
    }
    weightSelect.value = String(normalizeWeight(suggestion.weight) ?? 400);
    const weight = createSelectRow({ select: weightSelect, label: t`Weight`, field: 'font-weight', searchLabel: t`Search`, emptyText: t`No Results` });
    let style = suggestion.style === 'italic' ? 'italic' : 'normal';
    const styleRow = createToggleRow({
        label: t`Style`,
        field: 'font-style',
        choices: [['normal', t`Upright`], ['italic', t`Italic`]],
        value: style,
        onChange: value => { style = value; },
    });
    const { section } = createPrefGroup({ field: 'font-import', subtitle: t`TODO(copy)`, rows: [family, weight, styleRow] });
    section.querySelector('.ds-pref-group-subtitle')?.setAttribute('data-sb-copy-placeholder', 'true');

    const dialog = openDialog({
        title: t`Import Font`,
        subtitle: fileName,
        content: section,
        className: 'sb-font-naming-dialog',
        responses: { affirmative: { id: 'import', label: t`Import`, enabled: Boolean(sanitizeFamilyName(suggestion.family)) } },
        initialFocus: () => family.control,
    });
    // An empty family cannot be saved, so the response stays off until the field holds a name.
    family.control.addEventListener('input', () => dialog.setResponseEnabled('import', Boolean(sanitizeFamilyName(family.getValue()))));
    const { response } = await dialog.closed;
    if (response !== 'import') return null;
    return { family: sanitizeFamilyName(family.getValue()), weight: normalizeWeight(weightSelect.value) ?? 400, style };
}

/**
 * Imports font files: each is checked, read, accepted by the browser and uploaded, and the list is saved once at the end.
 * @param {File[]} files
 * @param {FontHost} host
 * @returns {Promise<FontEntry[]>} The entries that were added.
 */
export async function importFontFiles(files, host) {
    const list = [...files];
    let fonts = normalizeFonts(host.getFonts());
    const added = [];
    const replaced = [];
    const rejected = file => toastr.error(t`TODO(copy)`, file.name);

    if (fonts.length + list.length > MAX_FONT_FILES) {
        toastr.error(t`TODO(copy)`);
        return [];
    }

    for (const file of list) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const checked = validateFontFile(file, bytes);
        if (!checked.ok) {
            rejected(file);
            continue;
        }
        let face = await readFontMetadata(bytes);
        if (!face) {
            face = await openFontNamingDialog({ fileName: file.name });
            if (!face) continue;
        }
        if (!listImportedFamilies([...fonts, ...added]).includes(face.family) && listImportedFamilies([...fonts, ...added]).length >= MAX_FONT_FAMILIES) {
            toastr.error(t`TODO(copy)`);
            continue;
        }
        if (!await browserAccepts(face.family, bytes, face)) {
            rejected(file);
            continue;
        }
        const name = `${FONT_FILE_PREFIX}${host.uuid().replace(/-/g, '').slice(0, 12)}.${checked.extension}`;
        let path;
        try {
            path = await uploadFont(host, name, bytes);
        } catch (error) {
            console.error('Could not upload the font.', error);
            rejected(file);
            continue;
        }
        const [entry] = normalizeFonts([{ id: name.slice(FONT_FILE_PREFIX.length).split('.')[0], family: face.family, file: path, weight: face.weight, style: face.style, format: checked.format }]);
        if (!entry) {
            await deleteFontFile(host, { file: path });
            rejected(file);
            continue;
        }
        // The same family, weight and style replaces the older file.
        const same = font => font.family === entry.family && font.weight === entry.weight && font.style === entry.style;
        replaced.push(...fonts.filter(same));
        fonts = fonts.filter(font => !same(font));
        added.push(entry);
    }

    if (!added.length) return [];
    host.setFonts([...fonts, ...added]);
    host.save();
    host.apply();
    for (const entry of replaced) await deleteFontFile(host, entry);
    for (const family of listImportedFamilies(added)) toastr.success(t`Font imported`, family);
    return added;
}

/**
 * Removes an imported family after the user agrees. A font in use goes back to Default. The list is saved first, so a failed
 * delete leaves a stray file, never a list entry whose file is gone.
 * @param {string} family
 * @param {FontHost} host
 * @returns {Promise<boolean>} Whether the font was removed.
 */
export async function removeFontFamily(family, host) {
    const entries = normalizeFonts(host.getFonts()).filter(font => font.family === family);
    if (!entries.length) return false;
    const { openAlert } = await import('./sillybunny-editor/dialog.js');
    const response = await openAlert({
        heading: t`Remove Font`,
        body: t`TODO(copy)`,
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'delete', label: t`Delete`, appearance: 'destructive' },
        ],
    });
    if (response !== 'delete') return false;
    const ids = new Set(entries.map(entry => entry.id));
    host.setFonts(normalizeFonts(host.getFonts()).filter(font => !ids.has(font.id)));
    if (host.getChoice() === family) host.setChoice('');
    host.save();
    host.apply();
    const results = await Promise.all(entries.map(entry => deleteFontFile(host, entry)));
    if (results.includes(false)) toastr.error(t`Font not removed`, family);
    return true;
}
