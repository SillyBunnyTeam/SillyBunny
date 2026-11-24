import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

import extractChunks from 'png-chunks-extract';

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const CHUNK_HEADER_LENGTH = 8;
const CHUNK_CRC_LENGTH = 4;
// zlib.crc32 is in Node.js 22.2+ and Bun. Without it, png-chunks-extract reads the file instead.
const nativeCrc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null;

/**
 * Throws if a chunk up to IEND declares more data than the file holds. png-chunks-extract allocates, copies and
 * checksums the length that a chunk declares before it can find that the file is shorter, so without this check its
 * time and memory grow with the declared length instead of the file size.
 * @param {Uint8Array} data PNG file that starts with the PNG signature
 * @param {DataView} view View of the same bytes
 */
function checkChunkBounds(data, view) {
    for (let offset = PNG_SIGNATURE.length; offset < data.length;) {
        const room = data.length - offset - CHUNK_HEADER_LENGTH;
        if (room < 0 || view.getUint32(offset) > room) {
            throw new Error(`PNG chunk at byte ${offset} runs past the end of the file`);
        }
        if (
            data[offset + 4] === 0x49 &&
            data[offset + 5] === 0x45 &&
            data[offset + 6] === 0x4E &&
            data[offset + 7] === 0x44
        ) {
            break;
        }
        offset += CHUNK_HEADER_LENGTH + view.getUint32(offset) + CHUNK_CRC_LENGTH;
    }
}

/**
 * Throws the header error that png-chunks-extract throws for the first byte that differs from the PNG signature.
 * @param {Uint8Array} data File data
 */
function checkSignature(data) {
    for (let index = 0; index < PNG_SIGNATURE.length; index++) {
        if (data[index] !== PNG_SIGNATURE[index]) {
            const lineEndingByte = index === 4 || index === 5 || index === 7;
            throw new Error(lineEndingByte
                ? 'Invalid .png file header: possibly caused by DOS-Unix line ending conversion?'
                : 'Invalid .png file header');
        }
    }
}

/**
 * Walks PNG chunk headers with the checks and error messages of png-chunks-extract, returning zero-copy Uint8Array
 * views for the kept chunks. When `verifyChunk` returns false for a chunk type (for example multi-MB IDAT during fast
 * tEXt extraction), that chunk is neither copied nor CRC-checked.
 * @param {Uint8Array} data PNG file
 * @param {(name: string) => boolean} keep Whether to include the chunk in the returned array
 * @param {(name: string) => boolean} verifyChunk Whether to verify the chunk's CRC32
 * @returns {{ name: string, data: Uint8Array }[]} Kept chunks up to and including IEND
 */
function walkChunks(data, keep, verifyChunk) {
    checkSignature(data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    checkChunkBounds(data, view);

    const chunks = [];
    let chunkCount = 0;
    let offset = PNG_SIGNATURE.length;
    while (offset < data.length) {
        // checkChunkBounds has made sure that the header and the data of every chunk up to IEND are inside the file.
        const length = view.getUint32(offset);
        const nameStart = offset + 4;
        const dataStart = nameStart + 4;
        const dataEnd = dataStart + length;
        const name = String.fromCharCode(data[nameStart], data[nameStart + 1], data[nameStart + 2], data[nameStart + 3]);

        if (chunkCount === 0 && name !== 'IHDR') {
            throw new Error('IHDR header missing');
        }

        if (name === 'IEND') {
            if (keep(name)) {
                chunks.push({ name, data: new Uint8Array(0) });
            }
            return chunks;
        }

        if (verifyChunk(name)) {
            // png-chunks-extract reads a missing CRC byte at the end of a cut-off file as 0.
            const expected = (((data[dataEnd] ?? 0) << 24) | ((data[dataEnd + 1] ?? 0) << 16) | ((data[dataEnd + 2] ?? 0) << 8) | (data[dataEnd + 3] ?? 0)) >>> 0;
            if (nativeCrc32(data.subarray(nameStart, dataEnd)) !== expected) {
                throw new Error(`CRC values for ${name} header do not match, PNG file is likely corrupted`);
            }
        }

        if (keep(name)) {
            // Zero-copy plain Uint8Array view into the caller's buffer (avoids copying multi-MB IDAT chunks).
            chunks.push({ name, data: new Uint8Array(data.buffer, data.byteOffset + dataStart, length) });
        }
        chunkCount++;
        offset = dataEnd + CHUNK_CRC_LENGTH;
    }

    throw new Error('.png file ended prematurely: no IEND header was found');
}

/**
 * Decodes a PNG tEXt chunk payload identically to png-chunk-text's decode().
 * @param {Uint8Array} data Raw tEXt chunk payload
 * @returns {{ keyword: string, text: string }}
 */
function decodeTextChunkData(data) {
    const nulIndex = data.indexOf(0);
    if (nulIndex === -1) {
        return {
            keyword: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1'),
            text: '',
        };
    }

    if (data.indexOf(0, nulIndex + 1) !== -1) {
        throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content');
    }

    return {
        keyword: Buffer.from(data.buffer, data.byteOffset, nulIndex).toString('latin1'),
        text: Buffer.from(data.buffer, data.byteOffset + nulIndex + 1, data.byteLength - nulIndex - 1).toString('latin1'),
    };
}

/**
 * Extracts the chunks of a PNG file with the checks and error messages of png-chunks-extract. It first checks that the
 * header and the declared data of each chunk up to IEND lie inside the file, so a chunk that declares more data than
 * the file holds is rejected before anything is allocated for it.
 * @param {Uint8Array} data PNG file
 * @returns {{ name: string, data: Uint8Array }[]} Chunks up to and including IEND
 * @throws {Error} If a chunk runs past the end of the file, or if the file is not a valid PNG chunk stream
 */
export default function extract(data) {
    if (!nativeCrc32) {
        if (PNG_SIGNATURE.every((byte, index) => data[index] === byte)) {
            checkChunkBounds(data, new DataView(data.buffer, data.byteOffset, data.byteLength));
        }
        return extractChunks(data);
    }

    return walkChunks(data, () => true, () => true);
}

/**
 * Extracts only the tEXt chunks of a PNG file by walking chunk headers directly, skipping copy and CRC verification
 * of non-tEXt chunks (such as multi-MB IDAT pixel data). Still validates the PNG signature, IHDR-first ordering,
 * chunk bounds, IEND presence, and tEXt chunk CRCs.
 * @param {Uint8Array} data PNG file
 * @returns {{ name: string, data: Uint8Array }[]} tEXt chunks in file order
 * @throws {Error} If a chunk runs past the end of the file, or if the file header/structure/tEXt CRC is invalid
 */
export function extractTextChunks(data) {
    if (!nativeCrc32) {
        return extract(data).filter(chunk => chunk.name === 'tEXt');
    }

    return walkChunks(data, name => name === 'tEXt', name => name === 'tEXt');
}

/**
 * Extracts character card JSON text (preferring ccv3 over chara) from a PNG buffer without copying or CRC-verifying
 * multi-MB IDAT chunks. Matches character-card-parser's read() decoding semantics for tEXt chunks.
 * @param {Uint8Array} data PNG file
 * @returns {string} Decoded UTF-8 character card JSON text
 * @throws {Error} If the PNG structure/tEXt CRC is invalid, a tEXt chunk contains a NUL byte, or no card metadata exists
 */
export function extractCharacterCardText(data) {
    const textChunks = extractTextChunks(data).map(chunk => decodeTextChunkData(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const ccv3Chunk = textChunks.find(chunk => chunk.keyword.toLowerCase() === 'ccv3');
    if (ccv3Chunk) {
        return Buffer.from(ccv3Chunk.text, 'base64').toString('utf8');
    }

    const charaChunk = textChunks.find(chunk => chunk.keyword.toLowerCase() === 'chara');
    if (charaChunk) {
        return Buffer.from(charaChunk.text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
}
