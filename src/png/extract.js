import extractChunks from 'png-chunks-extract';

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const CHUNK_HEADER_LENGTH = 8;
const CHUNK_CRC_LENGTH = 4;

/**
 * Extracts the chunks of a PNG file with png-chunks-extract, after it checks that the header and the declared data of
 * each chunk up to IEND lie inside the file. png-chunks-extract allocates, copies and checksums the length that a chunk
 * declares before it can find that the file is shorter, so without this check its time and memory grow with the
 * declared length instead of the file size. Data without the PNG signature goes to png-chunks-extract unchecked,
 * which rejects it.
 * @param {Uint8Array} data PNG file
 * @returns {{ name: string, data: Uint8Array }[]} Chunks up to and including IEND
 * @throws {Error} If a chunk runs past the end of the file, or if png-chunks-extract rejects the file
 */
export default function extract(data) {
    if (PNG_SIGNATURE.every((byte, index) => data[index] === byte)) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let offset = PNG_SIGNATURE.length; offset < data.length;) {
            const room = data.length - offset - CHUNK_HEADER_LENGTH;
            if (room < 0 || view.getUint32(offset) > room) {
                throw new Error(`PNG chunk at byte ${offset} runs past the end of the file`);
            }
            if (String.fromCharCode(...data.subarray(offset + 4, offset + CHUNK_HEADER_LENGTH)) === 'IEND') {
                break;
            }
            offset += CHUNK_HEADER_LENGTH + view.getUint32(offset) + CHUNK_CRC_LENGTH;
        }
    }

    return extractChunks(data);
}
