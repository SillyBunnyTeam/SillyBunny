import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedCanCreateFileSymlinks;

/**
 * Returns the OS temp directory resolved through the native filesystem so
 * Windows 8.3 short paths match canonical paths from native realpath and git.
 * @returns {string}
 */
export function nativeTmpDir() {
    return fs.realpathSync.native(os.tmpdir());
}

/**
 * Unprivileged Windows without Developer Mode rejects file symbolic links with
 * EPERM or EACCES. Cached per process after one probe in the temp directory.
 * @returns {boolean}
 */
export function canCreateFileSymlinks() {
    if (cachedCanCreateFileSymlinks !== undefined) {
        return cachedCanCreateFileSymlinks;
    }

    const probeDirectory = fs.mkdtempSync(path.join(nativeTmpDir(), 'sillybunny-symlink-probe-'));
    const target = path.join(probeDirectory, 'target');
    const link = path.join(probeDirectory, 'link');
    try {
        fs.writeFileSync(target, '');
        fs.symlinkSync(target, link);
        cachedCanCreateFileSymlinks = true;
    } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
            cachedCanCreateFileSymlinks = false;
        } else {
            throw error;
        }
    } finally {
        fs.rmSync(probeDirectory, { recursive: true, force: true });
    }
    return cachedCanCreateFileSymlinks;
}

/**
 * Uses a native directory symlink when permitted and falls back to an NTFS
 * junction on Windows, where `lstatSync().isSymbolicLink()` stays true without
 * symlink privileges.
 * @param {string} targetPath Target directory path
 * @param {string} linkPath Link path to create
 */
export function createDirectoryLink(targetPath, linkPath) {
    try {
        fs.symlinkSync(targetPath, linkPath, 'dir');
    } catch (error) {
        if (process.platform !== 'win32' || (error?.code !== 'EPERM' && error?.code !== 'EACCES')) {
            throw error;
        }
        fs.symlinkSync(path.resolve(targetPath), linkPath, 'junction');
    }
}
