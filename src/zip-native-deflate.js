import { Transform, pipeline } from 'node:stream';
import zlib from 'node:zlib';

/**
 * The deflate level of backup entries. `archiver('zip')` deflated at zlib's best-speed level when no level was given,
 * so the backup size and time stay what they were.
 */
export const BACKUP_DEFLATE_LEVEL = 1;

const EMPTY_CHUNK = new Uint8Array(0);

/** @type {Int32Array | null} */
let crcTable = null;

/**
 * CRC-32 for runtimes whose `node:zlib` has no `crc32()`.
 * @param {Uint8Array} chunk Bytes to add
 * @param {number} [previous=0] CRC of the bytes before this chunk
 * @returns {number} CRC-32 of all bytes so far, as an unsigned integer
 */
export function crc32Fallback(chunk, previous = 0) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[n] = c;
        }
    }

    let crc = ~previous;
    for (let i = 0; i < chunk.length; i++) {
        crc = crcTable[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
    }
    return ~crc >>> 0;
}

/**
 * Running CRC-32: `crc32(chunk, crcOfEarlierBytes)`. The native one is an order of magnitude faster than any JavaScript loop.
 * @type {(chunk: Uint8Array, previous?: number) => number}
 */
export const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : crc32Fallback;

/**
 * The general-purpose flag bits that tell an extractor how hard the entry was deflated (same values as fflate's own entries).
 * @param {number} level zlib level
 * @returns {number} Value for the `flag` field of an fflate ZIP entry
 */
function getDeflateFlag(level) {
    if (level === 1) {
        return 3;
    }
    if (level < 6) {
        return 2;
    }
    return level === 9 ? 1 : 0;
}

/**
 * An entry for fflate's `Zip` writer whose data is deflated by native zlib.
 * fflate only needs the fields below, with `size` and `crc` (of the uncompressed data) final when the last chunk is
 * delivered to `ondata`, which `Zip.add()` installs. fflate stays the container writer; this class replaces its
 * JavaScript deflate, and computes the CRC-32 and the size on the stream that goes into the compressor.
 */
export class NativeDeflateZipEntry {
    /**
     * @param {string} filename Name of the entry inside the archive
     * @param {object} [options] Entry metadata, set before the entry is added to the `Zip`
     * @param {Date} [options.mtime] Modification time (1980 to 2099)
     */
    constructor(filename, { mtime = undefined } = {}) {
        this.filename = filename;
        this.compression = 8;
        this.flag = getDeflateFlag(BACKUP_DEFLATE_LEVEL);
        this.size = 0;
        this.crc = 0;
        /** @type {((error: Error | null, chunk: Uint8Array | null, final: boolean) => void) | undefined} */
        this.ondata = undefined;
        /** @type {import('node:stream').Stream[]} */
        this.streams = [];
        if (mtime !== undefined) {
            this.mtime = mtime;
        }
    }

    /**
     * Starts compressing a source stream. The source's bytes go through a checksum step into the deflate stream, so
     * the size and CRC always describe exactly the bytes that were compressed, whatever happens to the file meanwhile.
     * Backpressure holds along the whole chain: the caller reads the returned stream and the source is paused behind it.
     * @param {import('node:stream').Readable} source Uncompressed data
     * @returns {import('node:zlib').DeflateRaw} Stream of compressed chunks
     */
    start(source) {
        const deflate = zlib.createDeflateRaw({ level: BACKUP_DEFLATE_LEVEL });
        // The entry's fields are updated inside the stream's own callbacks, so `this` is captured here.
        const entry = this;
        const checksum = new Transform({
            transform(chunk, _encoding, callback) {
                entry.crc = crc32(chunk, entry.crc);
                entry.size += chunk.length;
                callback(null, chunk);
            },
        });

        // A failure of any step destroys the others with the same error, and the reader of `deflate` receives it.
        pipeline(source, checksum, deflate, () => {});
        this.streams = [source, checksum, deflate];
        return deflate;
    }

    /**
     * Delivers the last (empty) chunk. Call it after the compressed stream ended without an error.
     * @returns {void}
     */
    finish() {
        this.ondata?.(null, EMPTY_CHUNK, true);
    }

    /**
     * Stops the compression and releases the source, for an aborted backup.
     * @returns {void}
     */
    destroy() {
        for (const stream of this.streams) {
            stream.destroy();
        }
    }

    /**
     * Called by `Zip.terminate()`.
     * @returns {void}
     */
    terminate() {
        this.destroy();
    }
}
