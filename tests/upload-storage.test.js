import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import multer from 'multer';

import { createUploadStorage, ensureUploadDirectory } from '../src/middleware/uploadStorage.js';

const tempRoots = [];

function createTempRoot() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-uploads-'));
    tempRoots.push(tempRoot);
    return tempRoot;
}

afterEach(() => {
    jest.restoreAllMocks();

    for (const tempRoot of tempRoots.splice(0)) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

describe('upload storage', () => {
    test('creates a missing upload directory', () => {
        const uploadsPath = path.join(createTempRoot(), '_uploads');

        ensureUploadDirectory(uploadsPath);

        expect(fs.statSync(uploadsPath).isDirectory()).toBe(true);
    });

    test('accepts an existing directory without a recursive mkdir', () => {
        const uploadsPath = path.join(createTempRoot(), '_uploads');
        fs.mkdirSync(uploadsPath);
        const mkdirSpy = jest.spyOn(fs, 'mkdirSync');

        const storage = createUploadStorage(uploadsPath);
        const middleware = multer({ storage }).single('avatar');

        expect(middleware).toEqual(expect.any(Function));
        expect(mkdirSpy).toHaveBeenCalledTimes(1);
        expect(mkdirSpy).toHaveBeenCalledWith(uploadsPath);
    });

    test('rejects an existing file at the upload path', () => {
        const uploadsPath = path.join(createTempRoot(), '_uploads');
        fs.writeFileSync(uploadsPath, 'not a directory');

        expect(() => ensureUploadDirectory(uploadsPath)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    });

    test('rethrows unexpected directory creation errors', () => {
        const uploadsPath = path.join(createTempRoot(), '_uploads');
        const expectedError = Object.assign(new Error('permission denied'), { code: 'EPERM' });
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {
            throw expectedError;
        });

        expect(() => ensureUploadDirectory(uploadsPath)).toThrow(expectedError);
    });
});
