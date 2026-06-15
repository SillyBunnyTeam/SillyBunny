/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const mockedProcess = Object.create(process);
Object.defineProperty(mockedProcess, 'platform', { value: 'win32' });

await jest.unstable_mockModule('node:process', () => ({
    default: mockedProcess,
}));

const { tryWriteFileSync } = await import('../src/util.js');

let tempRoot;

function createWindowsFileLockError(code = 'EPERM') {
    return Object.assign(new Error(code), { code });
}

function mockWritableTarget() {
    jest.spyOn(globalThis.Atomics, 'wait').mockImplementation(() => 'timed-out');
    jest.spyOn(console, 'debug').mockImplementation(() => {});
}

function createTargetPath() {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-atomic-'));
    return path.join(tempRoot, 'example.jsonl');
}

afterEach(() => {
    jest.restoreAllMocks();
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = undefined;
    }
});

describe('tryWriteFileSync atomic fallback', () => {
    test('replaces the target via a temp file when atomic writes keep failing on Windows', () => {
        const filePath = createTargetPath();
        mockWritableTarget();
        const writeFileSpy = jest.spyOn(fs, 'writeFileSync');
        const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            if (renameSpy.mock.calls.length <= 4) {
                throw createWindowsFileLockError('EPERM');
            }
        });

        tryWriteFileSync(filePath, 'payload', 'utf8');

        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy).toHaveBeenCalledWith(`${filePath}.tmp`, 'payload', 'utf8');
        expect(renameSpy.mock.calls.at(-1)).toEqual([`${filePath}.tmp`, filePath]);
    });

    test('uses direct write only after the temp-file rename retries are exhausted', () => {
        const filePath = createTargetPath();
        mockWritableTarget();
        const writeFileSpy = jest.spyOn(fs, 'writeFileSync');
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw createWindowsFileLockError('EBUSY');
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        tryWriteFileSync(filePath, 'payload', 'utf8');

        expect(writeFileSpy.mock.calls.map(call => call[0])).toEqual([`${filePath}.tmp`, filePath]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Temp file rename failed'), 'EBUSY');
    });
});
