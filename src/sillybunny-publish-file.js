import fs from 'node:fs';
import path from 'node:path';

import { ensureDirectory, tryWriteFileSync } from './util.js';

/** The codes of a file system that cannot make a hard link: FAT and exFAT, some network and Android storage. */
export const NO_HARD_LINK_CODES = Object.freeze(new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS']));

/**
 * Publishes a new file without replacing one of the same name. The contents are written in a staging folder first,
 * so a half-written file never shows in the folder, and then linked into place: linking fails when the name is
 * taken, even across processes. Where the file system cannot link, the staged file is copied with an exclusive
 * copy, which also refuses an existing name but is not atomic.
 * @param {string} directory Folder that gets the file. It is made when it is missing.
 * @param {string} fileName Name of the file in that folder. The caller has sanitised it.
 * @param {string} contents
 * @param {object} [fileSystem] Replaceable for a test.
 * @param {typeof fs.linkSync} [fileSystem.link]
 * @param {typeof fs.copyFileSync} [fileSystem.copy]
 * @returns {boolean} False when a file of that name exists, and it is left as it is.
 */
export function publishNewFile(directory, fileName, contents, { link = fs.linkSync, copy = fs.copyFileSync } = {}) {
    if (!ensureDirectory(directory)) {
        throw new Error('The folder is not available.');
    }
    const staging = fs.mkdtempSync(path.join(directory, '.publish-'));
    try {
        const stagedPath = path.join(staging, 'staged');
        const targetPath = path.join(directory, fileName);
        tryWriteFileSync(stagedPath, contents, 'utf8', { expectedFileAbsent: true, durable: true });
        try {
            link(stagedPath, targetPath);
            return true;
        } catch (error) {
            if (error?.code === 'EEXIST') {
                return false;
            }
            if (!NO_HARD_LINK_CODES.has(error?.code)) {
                throw error;
            }
        }
        return copyExclusively(stagedPath, targetPath, copy);
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

/**
 * @param {string} from
 * @param {string} to
 * @param {typeof fs.copyFileSync} copy
 * @returns {boolean} False when `to` exists.
 */
function copyExclusively(from, to, copy) {
    try {
        copy(from, to, fs.constants.COPYFILE_EXCL);
        return true;
    } catch (error) {
        if (error?.code === 'EEXIST') {
            return false;
        }
        // The copy refuses an existing file before it creates anything, so a file here is the half this copy wrote.
        fs.rmSync(to, { force: true });
        throw error;
    }
}
