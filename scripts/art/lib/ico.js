const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;
// An ICO directory stores 0 for a side of 256 pixels, because the field is one byte.
const SIDE_256 = 0;

/**
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number }} The size the PNG header states.
 * @throws {Error} When the bytes are not a PNG.
 */
export function readPngSize(bytes) {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') {
        throw new Error('The bytes are not a PNG.');
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * @param {Buffer} bytes An ICO file.
 * @returns {Buffer[]} The picture of each entry, in the order of the directory.
 * @throws {Error} When the bytes are not an ICO file.
 */
export function readIco(bytes) {
    if (bytes.length < HEADER_BYTES || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
        throw new Error('The bytes are not an ICO file.');
    }
    const count = bytes.readUInt16LE(4);
    if (bytes.length < HEADER_BYTES + ENTRY_BYTES * count) {
        throw new Error('The ICO directory is cut short.');
    }
    return Array.from({ length: count }, (_, index) => {
        const at = HEADER_BYTES + index * ENTRY_BYTES;
        const [length, offset] = [bytes.readUInt32LE(at + 8), bytes.readUInt32LE(at + 12)];
        if (offset + length > bytes.length) {
            throw new Error(`ICO entry ${index + 1} reaches past the end of the file.`);
        }
        return bytes.subarray(offset, offset + length);
    });
}

/**
 * An ICO file whose entries are PNG pictures in the order given, each stored as 32 bits per pixel.
 * @param {{ size: number, png: Buffer }[]} entries Each `png` is exactly `size` by `size`, from 1 to 256.
 */
export function encodeIco(entries) {
    if (entries.length === 0 || entries.length > 0xffff) {
        throw new Error(`An ICO needs between 1 and 65535 entries, got ${entries.length}.`);
    }
    for (const { size, png } of entries) {
        const { width, height } = readPngSize(png);
        if (!Number.isInteger(size) || size < 1 || size > 256 || width !== size || height !== size) {
            throw new Error(`An ICO entry is a square of 1 to 256 pixels; the ${size} px entry holds a ${width}x${height} picture.`);
        }
    }
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries.length, 4);
    let offset = HEADER_BYTES + ENTRY_BYTES * entries.length;
    const directory = entries.map(({ size, png }) => {
        const entry = Buffer.alloc(ENTRY_BYTES);
        const side = size === 256 ? SIDE_256 : size;
        entry.writeUInt8(side, 0);
        entry.writeUInt8(side, 1);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(png.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += png.length;
        return entry;
    });
    return Buffer.concat([header, ...directory, ...entries.map(({ png }) => png)]);
}
