/**
 * The size in pixels that the header of a PNG or a WebP file states, so a test needs no image library.
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number }}
 */
export function readImageSize(bytes) {
    if (bytes.subarray(1, 4).toString('latin1') === 'PNG') {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WEBP') {
        throw new Error('The file is neither a PNG nor a WebP.');
    }
    const kind = bytes.subarray(12, 16).toString('latin1');
    if (kind === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') {
        return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}
