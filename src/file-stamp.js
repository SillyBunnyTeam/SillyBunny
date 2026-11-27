/**
 * Stamps that tell a cache whether a file changed after its contents were read.
 *
 * A stamp of (mtime, size) cannot see two writes of the same length that land in one file system clock tick, because
 * both writes get the same timestamp. The stamp here adds the inode and the change time, and it records whether the
 * file was old enough when it was stamped for the timestamps to tell a later write apart. A cache must re-read a file
 * whose stamp is not settled.
 *
 * Take the stamp before the contents are read. A write between the stamp and the read then shows up as a changed
 * stamp on the next lookup, and a write after the read lands in a later tick.
 */

import fs from 'node:fs';

/**
 * The longest time, in milliseconds, in which two writes to one file can still get the same timestamp. File system
 * clocks tick at most this slowly: a Linux kernel tick is 1 to 10 ms and an NTFS tick is about 15.6 ms.
 */
export const RACY_WINDOW_MS = 20;

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * @typedef {object} FileStamp
 * @property {bigint} ino Inode number. A rename over the file gives it a new one.
 * @property {bigint} size Size in bytes.
 * @property {bigint} mtimeNs Modification time in nanoseconds.
 * @property {bigint} ctimeNs Status change time in nanoseconds. A write that restores the old mtime still moves it.
 * @property {boolean} settled False when the newest timestamp was within `RACY_WINDOW_MS` of the moment of the stamp.
 * A write after such a stamp can carry the same timestamps, so the stamp cannot prove that the file is unchanged.
 */

/**
 * Makes a stamp from the stats of a file.
 * @param {import('node:fs').BigIntStats} stats Stats from a call with `{ bigint: true }`
 * @param {number} [nowMs] Current time in milliseconds since the epoch
 * @returns {FileStamp}
 */
export function createFileStamp(stats, nowMs = Date.now()) {
    const newestNs = stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs;
    const ageNs = BigInt(Math.trunc(nowMs)) * NANOSECONDS_PER_MILLISECOND - newestNs;
    return {
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
        settled: ageNs > BigInt(RACY_WINDOW_MS) * NANOSECONDS_PER_MILLISECOND,
    };
}

/**
 * Reads the stats of a file and stamps them.
 * @param {string} filePath Path to the file
 * @returns {{ stats: import('node:fs').BigIntStats, stamp: FileStamp }}
 */
export function statFileStamp(filePath) {
    const stats = fs.statSync(filePath, { bigint: true });
    return { stats, stamp: createFileStamp(stats) };
}

/**
 * Tells whether contents read under a stored stamp are still the contents of the file that is described by a new one.
 * @param {FileStamp | undefined} stored Stamp taken before the cached contents were read
 * @param {FileStamp} current Stamp of the file now
 * @returns {boolean} False when the file changed, or when the stored stamp cannot prove that it did not
 */
export function isFileStampCurrent(stored, current) {
    return Boolean(stored)
        && stored.settled
        && stored.ino === current.ino
        && stored.size === current.size
        && stored.mtimeNs === current.mtimeNs
        && stored.ctimeNs === current.ctimeNs;
}
