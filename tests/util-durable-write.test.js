import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { tryWriteFileSync } from '../src/util.js';

const describeDirectoryFsync = process.platform === 'win32' ? describe.skip : describe;
let tempRoot;

afterEach(() => {
    jest.restoreAllMocks();
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = undefined;
    }
});

describeDirectoryFsync('tryWriteFileSync durable writes', () => {
    test('flushes the parent directory after committing a durable write', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-durable-'));
        const filePath = path.join(tempRoot, 'metadata.json');
        const fsyncSync = fs.fsyncSync.bind(fs);
        let directoryFlushed = false;
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
            if (fs.fstatSync(fileDescriptor).isDirectory()) {
                directoryFlushed = true;
            }
            return fsyncSync(fileDescriptor);
        });

        tryWriteFileSync(filePath, '{}', 'utf8', { durable: true });

        expect(directoryFlushed).toBe(true);
    });

    test('accepts filesystems that do not support directory fsync', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-durable-'));
        const filePath = path.join(tempRoot, 'metadata.json');
        const fsyncSync = fs.fsyncSync.bind(fs);
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
            if (fs.fstatSync(fileDescriptor).isDirectory()) {
                throw Object.assign(new Error('unsupported'), { code: 'EINVAL' });
            }
            return fsyncSync(fileDescriptor);
        });

        expect(() => tryWriteFileSync(filePath, '{}', 'utf8', { durable: true })).not.toThrow();
        expect(fs.readFileSync(filePath, 'utf8')).toBe('{}');
    });
});
