import { MAX_IMAGE_BYTES, redactUrlCredentials, sanitizeReproducibleModel } from './security.js';

export const MAX_PNG_FILE_BYTES = MAX_IMAGE_BYTES;
export const MAX_PNG_METADATA_BYTES = 512 * 1024;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_DECODED_PNG_BYTES = 128 * 1024 * 1024;
export const QIG_STRUCTURED_METADATA_VERSION = 1;
export const QIG_STRUCTURED_METADATA_KEYWORD = 'qig';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const textDecoder = new TextDecoder();
const latin1Decoder = new TextDecoder('latin1');
const textEncoder = new TextEncoder();

function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError('Expected image bytes');
}

function hasPrefix(bytes, prefix) {
    return prefix.every((value, index) => bytes[index] === value);
}

function hasValidDimensions(width, height) {
    return Number.isSafeInteger(width) && Number.isSafeInteger(height)
        && width > 0 && height > 0
        && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION
        && width * height <= MAX_IMAGE_PIXELS;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function isStructurallyValidJpeg(bytes) {
    if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
    let offset = 2;
    let inScan = false;
    let sawFrame = false;
    let sawScan = false;
    let sawEntropyData = false;

    while (offset < bytes.length) {
        if (inScan) {
            while (offset < bytes.length && bytes[offset] !== 0xff) {
                sawEntropyData = true;
                offset++;
            }
            if (offset >= bytes.length) return false;
            while (offset < bytes.length && bytes[offset] === 0xff) offset++;
            if (offset >= bytes.length) return false;
            const scanMarker = bytes[offset++];
            if (scanMarker === 0x00) {
                sawEntropyData = true;
                continue;
            }
            if (scanMarker >= 0xd0 && scanMarker <= 0xd7) continue;
            if (scanMarker === 0xd9) return sawFrame && sawScan && sawEntropyData && offset === bytes.length;
            inScan = false;
            offset -= 2;
        }

        if (bytes[offset++] !== 0xff) return false;
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) return false;
        const marker = bytes[offset++];
        if (marker === 0xd9) return sawFrame && sawScan && sawEntropyData && offset === bytes.length;
        if (marker === 0xd8 || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false;
        if (offset + 2 > bytes.length) return false;
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) return false;
        if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
            if (length < 8) return false;
            const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
            const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
            if (!hasValidDimensions(width, height) || !bytes[offset + 7]) return false;
            sawFrame = true;
        }
        offset += length;
        if (marker === 0xda) {
            if (!sawFrame) return false;
            sawScan = true;
            inScan = true;
        }
    }
    return false;
}

function ascii(bytes, start, length) {
    return String.fromCharCode(...bytes.subarray(start, start + length));
}

function skipGifSubBlocks(bytes, start) {
    let offset = start;
    let dataBytes = 0;
    while (offset < bytes.length) {
        const size = bytes[offset++];
        if (size === 0) return { offset, dataBytes };
        if (offset + size > bytes.length) return null;
        dataBytes += size;
        offset += size;
    }
    return null;
}

function isStructurallyValidGif(bytes) {
    if (bytes.length < 20 || !/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const canvasWidth = view.getUint16(6, true);
    const canvasHeight = view.getUint16(8, true);
    if (!hasValidDimensions(canvasWidth, canvasHeight)) return false;
    let offset = 13;
    const packed = bytes[10];
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    if (offset > bytes.length) return false;
    let sawImage = false;
    while (offset < bytes.length) {
        const marker = bytes[offset++];
        if (marker === 0x3b) return sawImage && offset === bytes.length;
        if (marker === 0x21) {
            if (offset >= bytes.length) return false;
            const label = bytes[offset++];
            if (label === 0xf9) {
                if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) return false;
                offset += 6;
            } else {
                const skipped = skipGifSubBlocks(bytes, offset);
                if (!skipped) return false;
                offset = skipped.offset;
            }
            continue;
        }
        if (marker !== 0x2c || offset + 9 > bytes.length) return false;
        const width = view.getUint16(offset + 4, true);
        const height = view.getUint16(offset + 6, true);
        if (!hasValidDimensions(width, height)) return false;
        const imagePacked = bytes[offset + 8];
        offset += 9;
        if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
        if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false;
        const skipped = skipGifSubBlocks(bytes, offset + 1);
        if (!skipped || !skipped.dataBytes) return false;
        offset = skipped.offset;
        sawImage = true;
    }
    return false;
}

function isValidVp8Chunk(data) {
    if (data.length <= 10 || (data[0] & 1) !== 0 || ascii(data, 3, 3) !== "\x9d\x01\x2a") return false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return hasValidDimensions(view.getUint16(6, true) & 0x3fff, view.getUint16(8, true) & 0x3fff);
}

function isValidVp8lChunk(data) {
    if (data.length <= 5 || data[0] !== 0x2f) return false;
    const packed = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
    return (packed >>> 29) === 0
        && hasValidDimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
}

function isStructurallyValidWebp(bytes) {
    if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.length) return false;
    let offset = 12;
    let sawImage = false;
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) return false;
        const type = ascii(bytes, offset, 4);
        const size = view.getUint32(offset + 4, true);
        const dataStart = offset + 8;
        const dataEnd = dataStart + size;
        if (dataEnd > bytes.length) return false;
        const data = bytes.subarray(dataStart, dataEnd);
        if (type === "VP8 " && !isValidVp8Chunk(data)) return false;
        if (type === "VP8L" && !isValidVp8lChunk(data)) return false;
        if (type === "VP8 " || type === "VP8L") sawImage = true;
        if (type === "VP8X") {
            if (size !== 10) return false;
            const width = 1 + data[4] + (data[5] << 8) + (data[6] << 16);
            const height = 1 + data[7] + (data[8] << 8) + (data[9] << 16);
            if (!hasValidDimensions(width, height)) return false;
        }
        if (type === "ANMF") {
            if (size < 24) return false;
            const width = 1 + data[6] + (data[7] << 8) + (data[8] << 16);
            const height = 1 + data[9] + (data[10] << 8) + (data[11] << 16);
            if (!hasValidDimensions(width, height)) return false;
            const nestedType = ascii(data, 16, 4);
            const nestedSize = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(20, true);
            const nested = data.subarray(24, 24 + nestedSize);
            if (nested.length !== nestedSize) return false;
            if ((nestedType === "VP8 " && isValidVp8Chunk(nested)) || (nestedType === "VP8L" && isValidVp8lChunk(nested))) {
                sawImage = true;
            }
        }
        offset = dataEnd + (size & 1);
    }
    return sawImage && offset === bytes.length;
}

function isStructurallyValidBmp(bytes) {
    if (bytes.length < 30 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredLength = view.getUint32(2, true);
    const pixelOffset = view.getUint32(10, true);
    const dibSize = view.getUint32(14, true);
    if (declaredLength !== bytes.length || pixelOffset < 14 + dibSize || pixelOffset >= bytes.length || 14 + dibSize > bytes.length) return false;
    let width;
    let height;
    let planes;
    let bitsPerPixel;
    let compression = 0;
    let imageSize = 0;
    if (dibSize === 12) {
        width = view.getUint16(18, true);
        height = view.getUint16(20, true);
        planes = view.getUint16(22, true);
        bitsPerPixel = view.getUint16(24, true);
    } else if (dibSize >= 40) {
        width = view.getInt32(18, true);
        height = Math.abs(view.getInt32(22, true));
        planes = view.getUint16(26, true);
        bitsPerPixel = view.getUint16(28, true);
        compression = view.getUint32(30, true);
        imageSize = view.getUint32(34, true);
    } else return false;
    if (!hasValidDimensions(width, height) || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)) return false;
    if (compression === 0) {
        const rowBytes = Math.ceil((width * bitsPerPixel) / 32) * 4;
        return pixelOffset + rowBytes * height <= bytes.length;
    }
    return imageSize > 0 && pixelOffset + imageSize <= bytes.length;
}

function readTiffValues(bytes, entryOffset, littleEndian) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const widths = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    const width = widths[type];
    if (!width || !count || count > 1_000_000) return null;
    const byteLength = count * width;
    const start = byteLength <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8, littleEndian);
    if (start + byteLength > bytes.length) return null;
    if (![1, 3, 4].includes(type)) return [0];
    const values = [];
    for (let index = 0; index < count; index++) {
        const offset = start + index * width;
        values.push(width === 1 ? bytes[offset] : (width === 2 ? view.getUint16(offset, littleEndian) : view.getUint32(offset, littleEndian)));
    }
    return values;
}

function isStructurallyValidTiff(bytes) {
    if (bytes.length < 14) return false;
    const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
    const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d;
    if (!littleEndian && !bigEndian) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(2, littleEndian) !== 42) return false;
    const ifdOffset = view.getUint32(4, littleEndian);
    if (ifdOffset < 8 || ifdOffset + 2 > bytes.length) return false;
    const count = view.getUint16(ifdOffset, littleEndian);
    if (!count || ifdOffset + 2 + count * 12 + 4 > bytes.length) return false;
    const tags = new Map();
    for (let index = 0; index < count; index++) {
        const entryOffset = ifdOffset + 2 + index * 12;
        const tag = view.getUint16(entryOffset, littleEndian);
        const values = readTiffValues(bytes, entryOffset, littleEndian);
        if (!values) return false;
        tags.set(tag, values);
    }
    const width = tags.get(256)?.[0];
    const height = tags.get(257)?.[0];
    const offsets = tags.get(273) || tags.get(324) || tags.get(513);
    const byteCounts = tags.get(279) || tags.get(325) || tags.get(514);
    if (!hasValidDimensions(width, height) || !offsets?.length || !byteCounts?.length) return false;
    if (byteCounts.length !== 1 && offsets.length !== byteCounts.length) return false;
    return offsets.every((offset, index) => {
        const length = byteCounts[byteCounts.length === 1 ? 0 : index];
        return length > 0 && offset < bytes.length && offset + length <= bytes.length;
    });
}

function readIsoBoxes(bytes, start = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    let offset = start;
    while (offset < end) {
        if (offset + 8 > end) return null;
        let size = view.getUint32(offset);
        const type = ascii(bytes, offset + 4, 4);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) return null;
            const largeSize = view.getBigUint64(offset + 8);
            if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(largeSize);
            headerSize = 16;
        } else if (size === 0) size = end - offset;
        if (size < headerSize || offset + size > end) return null;
        boxes.push({ type, start: offset + headerSize, end: offset + size });
        offset += size;
    }
    return offset === end ? boxes : null;
}

function isStructurallyValidAvif(bytes) {
    if (bytes.length < 32) return false;
    const boxes = readIsoBoxes(bytes);
    if (!boxes) return false;
    const ftyp = boxes.find(box => box.type === "ftyp");
    const meta = boxes.find(box => box.type === "meta");
    const mdat = boxes.find(box => box.type === "mdat");
    if (!ftyp || !meta || !mdat || mdat.end <= mdat.start || ftyp.end - ftyp.start < 8) return false;
    const brands = ascii(bytes, ftyp.start, ftyp.end - ftyp.start);
    if (!brands.includes("avif") && !brands.includes("avis")) return false;
    if (meta.start + 4 > meta.end) return false;
    const metaBoxes = readIsoBoxes(bytes, meta.start + 4, meta.end);
    const required = new Set(["pitm", "iloc", "iinf", "iprp"]);
    if (!metaBoxes || !metaBoxes.some(box => box.type === "hdlr")
        || ![...required].every(type => metaBoxes.some(box => box.type === type))) return false;
    const iprp = metaBoxes.find(box => box.type === "iprp");
    const iprpBoxes = readIsoBoxes(bytes, iprp.start, iprp.end);
    const ipco = iprpBoxes?.find(box => box.type === "ipco");
    const properties = ipco && readIsoBoxes(bytes, ipco.start, ipco.end);
    const ispe = properties?.find(box => box.type === "ispe");
    if (!ispe || ispe.end - ispe.start < 12) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return hasValidDimensions(view.getUint32(ispe.start + 4), view.getUint32(ispe.start + 8));
}

export function detectImageFormat(value) {
    const bytes = asBytes(value);
    if (bytes.length >= 20 && hasPrefix(bytes, PNG_SIGNATURE)) {
        try {
            readChunks(bytes);
            return { ext: 'png', mime: 'image/png', isPng: true };
        } catch {
            return null;
        }
    }
    if (isStructurallyValidJpeg(bytes)) {
        return { ext: 'jpg', mime: 'image/jpeg', isPng: false };
    }
    if (isStructurallyValidGif(bytes)) {
        return { ext: 'gif', mime: 'image/gif', isPng: false };
    }
    if (isStructurallyValidWebp(bytes)) {
        return { ext: 'webp', mime: 'image/webp', isPng: false };
    }
    if (isStructurallyValidBmp(bytes)) {
        return { ext: 'bmp', mime: 'image/bmp', isPng: false };
    }
    if (isStructurallyValidTiff(bytes)) {
        return { ext: 'tiff', mime: 'image/tiff', isPng: false };
    }
    if (isStructurallyValidAvif(bytes)) {
        return { ext: 'avif', mime: 'image/avif', isPng: false };
    }
    return null;
}

function readChunks(value) {
    const bytes = asBytes(value);
    if (bytes.byteLength > MAX_PNG_FILE_BYTES) throw new Error('PNG exceeds the 25 MB limit');
    if (bytes.length < PNG_SIGNATURE.length || !hasPrefix(bytes, PNG_SIGNATURE)) throw new Error('Invalid PNG signature');

    const chunks = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = PNG_SIGNATURE.length;
    let sawIend = false;
    let sawHeader = false;
    let sawImageData = false;
    let imageDataEnded = false;
    while (offset < bytes.length) {
        if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk');
        const length = view.getUint32(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) throw new Error('Invalid PNG chunk length');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('Invalid PNG chunk type');
        const declaredCrc = view.getUint32(offset + 8 + length);
        const crcInput = bytes.subarray(offset + 4, offset + 8 + length);
        if (crc32(crcInput) !== declaredCrc) throw new Error(`Invalid PNG ${type} checksum`);
        if (!sawHeader) {
            if (type !== 'IHDR' || length !== 13) throw new Error('PNG must begin with IHDR');
            const width = view.getUint32(offset + 8);
            const height = view.getUint32(offset + 12);
            const bitDepth = bytes[offset + 16];
            const colorType = bytes[offset + 17];
            const validDepths = {
                0: [1, 2, 4, 8, 16],
                2: [8, 16],
                3: [1, 2, 4, 8],
                4: [8, 16],
                6: [8, 16],
            };
            if (!hasValidDimensions(width, height) || !validDepths[colorType]?.includes(bitDepth)
                || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0
                || ![0, 1].includes(bytes[offset + 20])) {
                throw new Error('Invalid PNG header');
            }
            sawHeader = true;
        } else if (type === 'IHDR') {
            throw new Error('PNG contains multiple IHDR chunks');
        }
        if (type === 'IDAT') {
            if (imageDataEnded) throw new Error('PNG IDAT chunks must be consecutive');
            if (length > 0) sawImageData = true;
        } else if (sawImageData) {
            imageDataEnded = true;
        }
        chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length), raw: bytes.subarray(offset, end) });
        offset = end;
        if (type === 'IEND') {
            sawIend = true;
            if (length !== 0 || offset !== bytes.length) throw new Error('Invalid PNG ending');
            break;
        }
    }
    if (!sawIend) throw new Error('PNG is missing IEND');
    if (!sawHeader || !sawImageData) throw new Error('PNG is missing required image data');
    assertZlibEnvelope(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data));
    return chunks;
}

function assertZlibEnvelope(parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (total < 6) throw new Error('PNG image data contains a truncated zlib stream');
    const byteAt = (target) => {
        let offset = target < 0 ? total + target : target;
        for (const part of parts) {
            if (offset < part.byteLength) return part[offset];
            offset -= part.byteLength;
        }
        return undefined;
    };
    const cmf = byteAt(0);
    const flags = byteAt(1);
    if ((cmf & 0x0f) !== 8 || (cmf >>> 4) > 7 || ((cmf << 8) | flags) % 31 !== 0 || (flags & 0x20)) {
        throw new Error('PNG image data has an invalid zlib header');
    }
    if ([byteAt(-4), byteAt(-3), byteAt(-2), byteAt(-1)].some(byte => byte === undefined)) {
        throw new Error('PNG image data has an invalid zlib checksum trailer');
    }
}

function pngScanlines(header) {
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
    const bitsPerPixel = channels * header.bitDepth;
    const passes = header.interlace === 0
        ? [[0, 0, 1, 1]]
        : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    const rows = [];
    let total = 0;
    for (const [startX, startY, stepX, stepY] of passes) {
        const width = header.width > startX ? Math.ceil((header.width - startX) / stepX) : 0;
        const height = header.height > startY ? Math.ceil((header.height - startY) / stepY) : 0;
        if (!width || !height) continue;
        const rowBytes = 1 + Math.ceil(width * bitsPerPixel / 8);
        total += rowBytes * height;
        if (total > MAX_DECODED_PNG_BYTES) throw new Error('Decoded PNG exceeds the configured size limit');
        for (let row = 0; row < height; row++) rows.push(rowBytes);
    }
    return { rows, total };
}

async function validatePngImageData(value) {
    const bytes = asBytes(value);
    const chunks = readChunks(bytes);
    const headerChunk = chunks[0];
    const view = new DataView(headerChunk.data.buffer, headerChunk.data.byteOffset, headerChunk.data.byteLength);
    const header = {
        width: view.getUint32(0),
        height: view.getUint32(4),
        bitDepth: headerChunk.data[8],
        colorType: headerChunk.data[9],
        interlace: headerChunk.data[12],
    };
    const scanlines = pngScanlines(header);
    if (typeof DecompressionStream !== 'function') return;

    const imageParts = chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data);
    const reader = new Blob(imageParts).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    let total = 0;
    let rowIndex = 0;
    let rowOffset = 0;
    try {
        while (true) {
            const { done, value: output } = await reader.read();
            if (done) break;
            total += output.byteLength;
            if (total > scanlines.total || total > MAX_DECODED_PNG_BYTES) {
                await reader.cancel('Decoded PNG exceeds the expected image size');
                throw new Error('Decoded PNG exceeds the expected image size');
            }
            for (const byte of output) {
                if (rowOffset === 0 && byte > 4) throw new Error('PNG contains an invalid scanline filter');
                rowOffset += 1;
                if (rowOffset === scanlines.rows[rowIndex]) {
                    rowIndex += 1;
                    rowOffset = 0;
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
    if (total !== scanlines.total || rowIndex !== scanlines.rows.length || rowOffset !== 0) {
        throw new Error('PNG decompressed data does not match its dimensions');
    }
}

export async function validateImageData(value) {
    const format = detectImageFormat(value);
    if (!format) return null;
    if (!format.isPng) return format;
    try {
        await validatePngImageData(value);
        return format;
    } catch {
        return null;
    }
}

function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
    const typeBytes = textEncoder.encode(type);
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes);
    crcInput.set(data, typeBytes.length);
    view.setUint32(data.length + 8, crc32(crcInput));
    return chunk;
}

function textKeywordEnd(data, keyword) {
    const end = data.indexOf(0);
    if (end < 0 || end > 79) return -1;
    return latin1Decoder.decode(data.subarray(0, end)) === keyword ? end : -1;
}

function isTextChunkForKeyword(chunk, keyword) {
    return (chunk.type === 'tEXt' || chunk.type === 'zTXt' || chunk.type === 'iTXt') && textKeywordEnd(chunk.data, keyword) >= 0;
}

function isParametersChunk(chunk) {
    return isTextChunkForKeyword(chunk, 'parameters');
}

function createInternationalTextData(keywordText, text) {
    const keyword = textEncoder.encode(keywordText);
    if (!keyword.length || keyword.length > 79 || keyword.includes(0)) throw new Error('Invalid PNG metadata keyword');
    const textBytes = textEncoder.encode(String(text ?? ''));
    const data = new Uint8Array(keyword.length + 5 + textBytes.length);
    data.set(keyword);
    let cursor = keyword.length;
    data[cursor++] = 0; // keyword terminator
    data[cursor++] = 0; // uncompressed
    data[cursor++] = 0; // compression method
    data[cursor++] = 0; // language tag
    data[cursor++] = 0; // translated keyword
    data.set(textBytes, cursor);
    return data;
}

function replacePngTextMetadata(value, keyword, text, { insert = true } = {}) {
    const chunks = readChunks(value);
    const metadataData = insert ? createInternationalTextData(keyword, text) : null;
    if (metadataData && metadataData.byteLength > MAX_PNG_METADATA_BYTES) {
        throw new Error('PNG metadata exceeds the 512 KB limit');
    }
    const metadataChunk = metadataData ? createChunk('iTXt', metadataData) : null;

    const outputParts = [PNG_SIGNATURE];
    for (const chunk of chunks) {
        if (isTextChunkForKeyword(chunk, keyword)) continue;
        if (chunk.type === 'IEND' && metadataChunk) outputParts.push(metadataChunk);
        outputParts.push(chunk.raw);
    }
    const total = outputParts.reduce((sum, part) => sum + part.length, 0);
    if (total > MAX_PNG_FILE_BYTES) throw new Error('PNG with metadata exceeds the 25 MB limit');
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of outputParts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output.buffer;
}

export function embedPngMetadata(value, text) {
    return replacePngTextMetadata(value, 'parameters', sanitizeGenerationParameterText(text));
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

const STRUCTURED_PRIVATE_FIELD = /(?:api.?key|key$|token|secret|password|credential|authorization|ref.*image|image.*ref|control.*image|url$|endpoint$|workflow|graph|allowlegacyinterrupt|requesttemplate|customapi)/i;
const FORBIDDEN_STRUCTURED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sanitizeStructuredValue(value, key = '', state = { nodes: 0 }, depth = 0) {
    if (key.startsWith('_') || STRUCTURED_PRIVATE_FIELD.test(key) || depth > 16) return undefined;
    state.nodes += 1;
    if (state.nodes > 25_000) throw new Error('Structured PNG metadata contains too many values');
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
        if (/^(?:data:image\/|blob:)/i.test(value)) return undefined;
        if (textEncoder.encode(value).byteLength > 16 * 1024) return undefined;
        return /model$/i.test(key) ? sanitizeReproducibleModel(value) : redactUrlCredentials(value);
    }
    if (Array.isArray(value)) {
        return value.slice(0, 2_000)
            .map(item => sanitizeStructuredValue(item, key, state, depth + 1))
            .filter(item => item !== undefined);
    }
    if (!isPlainObject(value)) return undefined;
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 2_000)) {
        if (FORBIDDEN_STRUCTURED_KEYS.has(childKey)) continue;
        const sanitized = sanitizeStructuredValue(childValue, childKey, state, depth + 1);
        if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
}

function removeCustomProviderModels(value) {
    if (Array.isArray(value)) {
        value.forEach(removeCustomProviderModels);
        return value;
    }
    if (!isPlainObject(value)) return value;
    if (String(value.provider || '').toLowerCase() === 'custom') {
        delete value.model;
        if (isPlainObject(value.parameters)) delete value.parameters.model;
        if (isPlainObject(value.settings)) delete value.settings.model;
    }
    Object.values(value).forEach(removeCustomProviderModels);
    return value;
}

function sanitizeGenerationParameterText(value) {
    const source = String(value ?? '');
    const lines = source.split('\n');
    const lastLine = lines.at(-1) || '';
    if (!/(?:^|,\s*)Provider:\s*[^,\n]+/.test(lastLine)) return source;
    const segments = lastLine.split(/,\s*/);
    const provider = segments.find(segment => /^Provider:\s*/.test(segment))?.replace(/^Provider:\s*/, '').trim().toLowerCase();
    const sanitized = segments.flatMap(segment => {
        const match = segment.match(/^Model:\s*([\s\S]*)$/);
        if (!match) return [segment];
        if (provider === 'custom') return [];
        const model = sanitizeReproducibleModel(match[1].trim(), provider);
        return model === undefined ? [] : [`Model: ${model}`];
    });
    lines[lines.length - 1] = sanitized.join(', ');
    return lines.join('\n');
}

export function serializeStructuredGenerationMetadata(data) {
    const sanitized = removeCustomProviderModels(sanitizeStructuredValue(data || {}));
    if (!isPlainObject(sanitized)) throw new Error('Structured PNG metadata must be an object');
    const text = JSON.stringify({ version: QIG_STRUCTURED_METADATA_VERSION, data: sanitized });
    if (textEncoder.encode(text).byteLength > MAX_PNG_METADATA_BYTES) {
        throw new Error('Structured PNG metadata exceeds the 512 KB limit');
    }
    return text;
}

export function parseStructuredGenerationMetadata(text) {
    if (typeof text !== 'string' || textEncoder.encode(text).byteLength > MAX_PNG_METADATA_BYTES) {
        throw new Error('Structured PNG metadata exceeds the 512 KB limit');
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Structured PNG metadata is not valid JSON');
    }
    if (!isPlainObject(parsed) || parsed.version !== QIG_STRUCTURED_METADATA_VERSION || !isPlainObject(parsed.data)) {
        throw new Error(`Unsupported structured PNG metadata version: ${parsed?.version ?? 'missing'}`);
    }
    const data = removeCustomProviderModels(sanitizeStructuredValue(parsed.data));
    if (!isPlainObject(data)) throw new Error('Structured PNG metadata data must be an object');
    return { version: QIG_STRUCTURED_METADATA_VERSION, data };
}

export function embedPngMetadataBundle(value, metadata = {}) {
    const hasParameters = Object.prototype.hasOwnProperty.call(metadata, 'parameters');
    const hasStructured = Object.prototype.hasOwnProperty.call(metadata, 'structured');
    const parameters = hasParameters ? sanitizeGenerationParameterText(metadata.parameters) : null;
    const structured = hasStructured && metadata.structured != null
        ? serializeStructuredGenerationMetadata(metadata.structured)
        : null;
    const combinedBytes = (parameters == null ? 0 : textEncoder.encode(parameters).byteLength)
        + (structured == null ? 0 : textEncoder.encode(structured).byteLength);
    if (combinedBytes > MAX_PNG_METADATA_BYTES) throw new Error('PNG metadata exceeds the 512 KB limit');

    let output = value;
    if (hasParameters) output = replacePngTextMetadata(output, 'parameters', parameters);
    if (hasStructured) {
        output = replacePngTextMetadata(output, QIG_STRUCTURED_METADATA_KEYWORD, structured, {
            insert: structured != null,
        });
    }
    return output;
}

async function decompressBounded(data, maxBytes) {
    if (typeof DecompressionStream !== 'function') return null;
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel('PNG metadata is too large');
                throw new Error('Decompressed PNG metadata exceeds the 512 KB limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function decodeTextChunk(chunk, keyword) {
    if (chunk.data.byteLength > MAX_PNG_METADATA_BYTES) throw new Error('PNG metadata chunk exceeds the 512 KB limit');
    const keywordEnd = textKeywordEnd(chunk.data, keyword);
    if (keywordEnd < 0) return null;
    if (chunk.type === 'tEXt') return latin1Decoder.decode(chunk.data.subarray(keywordEnd + 1));
    if (chunk.type === 'zTXt') {
        if (chunk.data[keywordEnd + 1] !== 0) return null;
        const decompressed = await decompressBounded(chunk.data.subarray(keywordEnd + 2), MAX_PNG_METADATA_BYTES);
        return decompressed ? latin1Decoder.decode(decompressed) : null;
    }

    let cursor = keywordEnd + 1;
    if (cursor + 2 > chunk.data.length) return null;
    const compressed = chunk.data[cursor++];
    const method = chunk.data[cursor++];
    for (let field = 0; field < 2; field++) {
        while (cursor < chunk.data.length && chunk.data[cursor] !== 0) cursor++;
        if (cursor >= chunk.data.length) return null;
        cursor++;
    }
    let textBytes = chunk.data.subarray(cursor);
    if (compressed === 1) {
        if (method !== 0) return null;
        textBytes = await decompressBounded(textBytes, MAX_PNG_METADATA_BYTES);
        if (!textBytes) return null;
    } else if (compressed !== 0 || method !== 0) {
        return null;
    }
    return textDecoder.decode(textBytes);
}

export async function readPngMetadataBundle(value) {
    const chunks = readChunks(value);
    let parameters = null;
    let structuredText = null;
    for (const chunk of chunks) {
        if (isParametersChunk(chunk)) {
            const decoded = await decodeTextChunk(chunk, 'parameters');
            if (decoded !== null) parameters = decoded;
        }
        if (isTextChunkForKeyword(chunk, QIG_STRUCTURED_METADATA_KEYWORD)) {
            const decoded = await decodeTextChunk(chunk, QIG_STRUCTURED_METADATA_KEYWORD);
            if (decoded !== null) structuredText = decoded;
        }
    }
    return {
        parameters,
        structured: structuredText == null ? null : parseStructuredGenerationMetadata(structuredText),
    };
}

export async function readPngMetadata(value) {
    return (await readPngMetadataBundle(value)).parameters;
}

export function parseGenerationParameters(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const bounded = text.slice(0, MAX_PNG_METADATA_BYTES);
    const lines = bounded.split('\n');
    const parameterLinePattern = /(?:^|,\s*)(?:Steps|Sampler|Scheduler|CFG scale|Seed|Size|Provider|Model|Backend):\s*[^,\n]+/;
    let params = parameterLinePattern.test(lines.at(-1) || '') ? lines.pop().trim() : '';
    const body = lines.join('\n');
    const negativeMarker = '\nNegative prompt: ';
    const negativeIndex = body.lastIndexOf(negativeMarker);
    let prompt = (negativeIndex >= 0 ? body.slice(0, negativeIndex) : body).trim();
    let negativePrompt = '';
    if (negativeIndex >= 0) negativePrompt = body.slice(negativeIndex + negativeMarker.length).trim();

    const getParam = (key) => params.match(new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ([^,\n]+)`))?.[1]?.trim() || null;
    const result = { prompt: prompt.slice(0, 16 * 1024), negativePrompt: negativePrompt.slice(0, 16 * 1024) };
    const clampNumber = (value, min, max, integer = false) => {
        if (value == null || value === '') return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return undefined;
        const clamped = Math.min(max, Math.max(min, parsed));
        return integer ? Math.trunc(clamped) : clamped;
    };
    const provider = getParam('Provider')?.slice(0, 200);
    const steps = clampNumber(getParam('Steps'), 1, 150, true);
    const cfgScale = clampNumber(getParam('CFG scale'), String(provider || '').toLowerCase() === 'proxy' ? 0 : 1, 30);
    const seed = clampNumber(getParam('Seed'), 0, 0xffffffff, true);
    const size = getParam('Size')?.match(/^(\d+)x(\d+)$/i);
    if (steps !== undefined) result.steps = steps;
    if (cfgScale !== undefined) result.cfgScale = cfgScale;
    if (seed !== undefined) result.seed = seed;
    if (size) {
        result.width = clampNumber(size[1], 256, 2048, true);
        result.height = clampNumber(size[2], 256, 2048, true);
    }
    if (provider) result.provider = provider;
    for (const [key, outputKey] of [['Sampler', 'sampler'], ['Scheduler', 'scheduler'], ['Backend', 'backend']]) {
        const value = getParam(key);
        if (value) result[outputKey] = value.slice(0, 200);
    }
    const model = getParam('Model');
    if (model && String(result.provider || '').toLowerCase() !== 'custom') {
        const sanitizedModel = sanitizeReproducibleModel(model.slice(0, 200), result.provider);
        if (sanitizedModel !== undefined) result.model = sanitizedModel;
    }
    return result;
}

export function sanitizeServerSubfolder(value, fallback = 'QuickImageGen') {
    const sanitized = String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/_+/g, '_')
        .replace(/^\.+|\.+$/g, '')
        .trim()
        .slice(0, 80);
    return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}
