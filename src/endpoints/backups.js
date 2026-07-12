import express from 'express';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { formatBytes } from '../util.js';
import { CHAT_BACKUPS_PREFIX } from './chats.js';

export const router = express.Router();

/**
 * Checks whether a name is a canonical top-level chat backup filename.
 * @param {unknown} name Filename to check
 * @returns {name is string} Whether the name is valid
 */
export function isCanonicalChatBackupName(name) {
    return typeof name === 'string'
        && name.startsWith(CHAT_BACKUPS_PREFIX)
        && path.extname(name) === '.jsonl'
        && path.basename(name) === name
        && sanitize(name) === name;
}

/**
 * Inspects a requested backup without following symbolic links.
 * @param {string} directory User backup directory
 * @param {unknown} name Requested filename
 * @returns {Promise<{status: number, filePath?: string, stats?: import('node:fs').Stats}>} Inspection result
 */
export async function inspectChatBackupFile(directory, name) {
    if (!isCanonicalChatBackupName(name)) {
        return { status: 400 };
    }

    const filePath = path.join(directory, name);
    let stats;
    try {
        stats = await fsPromises.lstat(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { status: 404 };
        }
        throw error;
    }

    if (stats.isSymbolicLink() || !stats.isFile()) {
        return { status: 400 };
    }

    return { status: 200, filePath, stats };
}

/**
 * Lists regular chat backup files using filesystem metadata only.
 * @param {string} directory User backup directory
 * @returns {Promise<object[]>} Backup metadata
 */
export async function listChatBackupModels(directory) {
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    const candidates = entries.filter(entry => isCanonicalChatBackupName(entry.name));
    const settledBackups = await Promise.allSettled(candidates.map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const stats = await fsPromises.lstat(filePath);

        if (stats.isSymbolicLink() || !stats.isFile()) {
            return null;
        }

        return {
            file_name: entry.name,
            file_size: formatBytes(stats.size),
            last_mes: stats.mtimeMs,
            mtime: stats.mtimeMs,
        };
    }));

    return settledBackups
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value);
}

router.post('/chat/get', async (request, response) => {
    try {
        const backupModels = await listChatBackupModels(request.user.directories.backups);
        return response.json(backupModels);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/chat/delete', async (request, response) => {
    try {
        const name = request.body?.name;
        const backup = await inspectChatBackupFile(request.user.directories.backups, name);

        if (backup.status !== 200) {
            if (backup.status === 400) {
                console.warn('Attempt to delete non-chat backup file:', name);
            }
            return response.sendStatus(backup.status);
        }

        await fsPromises.unlink(backup.filePath);
        return response.sendStatus(200);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return response.sendStatus(404);
        }
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/chat/download', async (request, response) => {
    try {
        const name = request.body?.name;
        const backup = await inspectChatBackupFile(request.user.directories.backups, name);

        if (backup.status !== 200) {
            if (backup.status === 400) {
                console.warn('Attempt to download non-chat backup file:', name);
            }
            return response.sendStatus(backup.status);
        }

        return response.download(backup.filePath);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
