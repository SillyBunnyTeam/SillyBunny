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
    test('writes directly when the target must keep its filesystem identity', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'before', 'utf8');
        const inodeBefore = fs.statSync(filePath).ino;
        mockWritableTarget();
        const writeFileSpy = jest.spyOn(fs, 'writeFileSync');
        const renameSpy = jest.spyOn(fs, 'renameSync');

        tryWriteFileSync(filePath, 'after', 'utf8', { preserveFileIdentity: true });

        expect(writeFileSpy).toHaveBeenCalledTimes(1);
        expect(writeFileSpy.mock.calls[0].slice(1)).toEqual(['after', 'utf8']);
        expect(renameSpy).not.toHaveBeenCalled();
        expect(fs.statSync(filePath).ino).toBe(inodeBefore);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('after');
    });

    test('retries identity-preserving writes without replacing the target', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'before', 'utf8');
        mockWritableTarget();
        const openSync = fs.openSync.bind(fs);
        let failures = 0;
        const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((target, flags) => {
            if (target === filePath && failures++ < 2) {
                throw createWindowsFileLockError('EBUSY');
            }
            return openSync(target, flags);
        });
        const renameSpy = jest.spyOn(fs, 'renameSync');

        tryWriteFileSync(filePath, 'after', 'utf8', { preserveFileIdentity: true });

        expect(openSpy).toHaveBeenCalledTimes(3);
        expect(renameSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(filePath, 'utf8')).toBe('after');
    });

    test('does not replace the target when direct retries are exhausted', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'before', 'utf8');
        mockWritableTarget();
        jest.spyOn(fs, 'openSync').mockImplementation(() => {
            throw createWindowsFileLockError('EPERM');
        });
        const renameSpy = jest.spyOn(fs, 'renameSync');
        const copyFileSpy = jest.spyOn(fs, 'copyFileSync');

        expect(() => tryWriteFileSync(filePath, 'after', 'utf8', { preserveFileIdentity: true })).toThrow('EPERM');

        expect(renameSpy).not.toHaveBeenCalled();
        expect(copyFileSpy).not.toHaveBeenCalled();
    });

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

    test('copies the temp file when temp-file rename retries are exhausted', () => {
        const filePath = createTargetPath();
        mockWritableTarget();
        const writeFileSpy = jest.spyOn(fs, 'writeFileSync');
        const copyFileSpy = jest.spyOn(fs, 'copyFileSync');
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw createWindowsFileLockError('EBUSY');
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        tryWriteFileSync(filePath, 'payload', 'utf8');

        expect(writeFileSpy.mock.calls.map(call => call[0])).toEqual([`${filePath}.tmp`]);
        expect(copyFileSpy).toHaveBeenCalledWith(`${filePath}.tmp`, filePath);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Temp file rename failed'), 'EBUSY');
        expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('payload');
    });

    test('uses direct write only after temp-file rename and copy retries are exhausted', () => {
        const filePath = createTargetPath();
        mockWritableTarget();
        const writeFileSpy = jest.spyOn(fs, 'writeFileSync');
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw createWindowsFileLockError('EBUSY');
        });
        jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {
            throw createWindowsFileLockError('EPERM');
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        tryWriteFileSync(filePath, 'payload', 'utf8');

        expect(writeFileSpy.mock.calls.map(call => call[0])).toEqual([`${filePath}.tmp`, filePath]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Temp file rename failed'), 'EBUSY');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Temp file copy failed'), 'EPERM');
        expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    });
});
