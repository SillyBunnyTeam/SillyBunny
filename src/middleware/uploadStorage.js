import fs from 'node:fs';

import multer from 'multer';

function isDirectory(directoryPath) {
    try {
        return fs.statSync(directoryPath).isDirectory();
    } catch {
        return false;
    }
}

export function ensureUploadDirectory(uploadsPath) {
    try {
        fs.mkdirSync(uploadsPath);
    } catch (error) {
        if (error?.code === 'EEXIST' && isDirectory(uploadsPath)) {
            return;
        }

        throw error;
    }
}

export function createUploadStorage(uploadsPath) {
    ensureUploadDirectory(uploadsPath);

    return multer.diskStorage({
        destination: (_request, _file, callback) => callback(null, uploadsPath),
    });
}
