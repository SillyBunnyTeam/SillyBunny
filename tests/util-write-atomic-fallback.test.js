/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const mockedProcess = Object.create(process);
Object.defineProperty(mockedProcess, 'platform', { value: 'win32' });

await jest.unstable_mockModule('node:process', () => ({
    default: mockedProcess,
}));

const { recoverFileWritesInDirectorySync, recoverFileWriteSync, tryWriteFileSync } = await import('../src/util.js');

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
        const renameSpy = jest.spyOn(fs, 'renameSync');

        tryWriteFileSync(filePath, 'after', 'utf8', { preserveFileIdentity: true });

        expect(renameSpy.mock.calls.some(([, destination]) => destination === filePath)).toBe(false);
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

        expect(openSpy.mock.calls.filter(([target]) => target === filePath)).toHaveLength(3);
        expect(renameSpy.mock.calls.some(([, destination]) => destination === filePath)).toBe(false);
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

    test('restores the original bytes when an identity-preserving write fails after mutation', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'original-card-content', 'utf8');
        jest.spyOn(fs, 'ftruncateSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('simulated truncate failure'), { code: 'EIO' });
        });

        expect(() => tryWriteFileSync(filePath, 'new', 'utf8', { preserveFileIdentity: true })).toThrow('simulated truncate failure');

        expect(fs.readFileSync(filePath, 'utf8')).toBe('original-card-content');
        expect(fs.readdirSync(tempRoot)).toEqual([path.basename(filePath)]);
    });

    test('does not truncate when writing already produced the target size', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'before', 'utf8');
        mockWritableTarget();
        const truncateSpy = jest.spyOn(fs, 'ftruncateSync').mockImplementation(() => {
            throw createWindowsFileLockError('EBUSY');
        });

        expect(() => tryWriteFileSync(filePath, 'after-is-longer', 'utf8', { preserveFileIdentity: true })).not.toThrow();

        expect(truncateSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(filePath, 'utf8')).toBe('after-is-longer');
    });

    test('restores a shorter write when Windows keeps truncation locked', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'original-card-content', 'utf8');
        mockWritableTarget();
        jest.spyOn(fs, 'ftruncateSync').mockImplementation(() => {
            throw createWindowsFileLockError('EBUSY');
        });

        expect(() => tryWriteFileSync(filePath, 'short', 'utf8', { preserveFileIdentity: true })).toThrow('EBUSY');

        expect(fs.readFileSync(filePath, 'utf8')).toBe('original-card-content');
        expect(fs.readdirSync(tempRoot)).toEqual([path.basename(filePath)]);
    });

    test('recovers the original bytes from a durable interrupted-write record', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'original-card-content', 'utf8');
        const unlinkSync = fs.unlinkSync.bind(fs);
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
            if (String(target).endsWith('.sillybunny-write-recovery')) {
                throw createWindowsFileLockError('EPERM');
            }
            return unlinkSync(target);
        });
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => tryWriteFileSync(filePath, 'new-card-content', 'utf8', { preserveFileIdentity: true })).toThrow(/write recovery file/i);
        unlinkSpy.mockRestore();
        fs.writeFileSync(filePath, 'partial', 'utf8');

        expect(recoverFileWriteSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('original-card-content');
        expect(fs.readdirSync(tempRoot)).toEqual([path.basename(filePath)]);
    });

    test('refuses to mutate a hard-linked target in place', () => {
        const filePath = createTargetPath();
        const aliasPath = path.join(tempRoot, 'alias.jsonl');
        fs.writeFileSync(filePath, 'before', 'utf8');
        fs.linkSync(filePath, aliasPath);

        expect(() => tryWriteFileSync(filePath, 'after', 'utf8', { preserveFileIdentity: true })).toThrow(/hard-linked/i);

        expect(fs.readFileSync(filePath, 'utf8')).toBe('before');
        expect(fs.readFileSync(aliasPath, 'utf8')).toBe('before');
    });

    test('refuses an identity-preserving write after the checked file is replaced', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'before', 'utf8');
        const checked = fs.statSync(filePath, { bigint: true });
        const replacementPath = `${filePath}.replacement`;
        fs.writeFileSync(replacementPath, 'replacement', 'utf8');
        fs.renameSync(replacementPath, filePath);

        expect(() => tryWriteFileSync(filePath, 'after', 'utf8', {
            preserveFileIdentity: true,
            expectedFileIdentity: { dev: checked.dev, ino: checked.ino },
        })).toThrow(/replaced file/i);

        expect(fs.readFileSync(filePath, 'utf8')).toBe('replacement');
    });

    test('refuses an identity-preserving write after the checked bytes change in place', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'checked bytes', 'utf8');
        const checked = fs.statSync(filePath, { bigint: true });
        const expectedFileHash = crypto.createHash('sha256').update('checked bytes').digest('hex');
        fs.writeFileSync(filePath, 'concurrent bytes', 'utf8');

        expect(() => tryWriteFileSync(filePath, 'requested bytes', 'utf8', {
            preserveFileIdentity: true,
            expectedFileIdentity: { dev: checked.dev, ino: checked.ino },
            expectedFileHash,
        })).toThrow(/changed file/i);

        expect(fs.readFileSync(filePath, 'utf8')).toBe('concurrent bytes');
    });

    test('does not delete a file that replaces an exclusive create in progress', () => {
        const filePath = createTargetPath();
        const displacedPath = `${filePath}.displaced`;
        const writeSync = fs.writeSync.bind(fs);
        let replaced = false;
        jest.spyOn(fs, 'writeSync').mockImplementation((descriptor, ...args) => {
            if (!replaced) {
                replaced = true;
                fs.renameSync(filePath, displacedPath);
                fs.writeFileSync(filePath, 'concurrent bytes', 'utf8');
            }
            return writeSync(descriptor, ...args);
        });

        expect(() => tryWriteFileSync(filePath, 'requested bytes', 'utf8', {
            expectedFileAbsent: true,
        })).toThrow(/changed file/i);

        expect(fs.readFileSync(filePath, 'utf8')).toBe('concurrent bytes');
    });

    test('keeps an interrupted guarded write invalid for recovery', () => {
        const filePath = createTargetPath();
        // The new bytes have to be shorter than the old ones for the write to reach a resize at
        // all: resizeFileSync skips ftruncateSync when writing already produced the target size,
        // which the sibling test above pins. A same-size payload never enters the failing step.
        fs.writeFileSync(filePath, '{"old":true,"padding":"shrunk away by the new write"}\n', 'utf8');
        const checked = fs.statSync(filePath, { bigint: true });
        jest.spyOn(fs, 'ftruncateSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
        });

        expect(() => tryWriteFileSync(filePath, '{"new":true}\n', 'utf8', {
            preserveFileIdentity: true,
            expectedFileIdentity: { dev: checked.dev, ino: checked.ino },
            invalidateBeforeWrite: true,
        })).toThrow('I/O failure');

        expect(() => JSON.parse(fs.readFileSync(filePath, 'utf8').split('\n')[0])).toThrow();
    });

    test('re-invalidates a guarded write when its final flush fails', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, '{"old":true}\n', 'utf8');
        const checked = fs.statSync(filePath, { bigint: true });
        const fsyncSync = fs.fsyncSync.bind(fs);
        let flushes = 0;
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
            if (++flushes === 3) {
                throw Object.assign(new Error('final flush failed'), { code: 'EIO' });
            }
            return fsyncSync(fileDescriptor);
        });

        expect(() => tryWriteFileSync(filePath, '{"new":true}\n', 'utf8', {
            preserveFileIdentity: true,
            expectedFileIdentity: { dev: checked.dev, ino: checked.ino },
            invalidateBeforeWrite: true,
        })).toThrow('final flush failed');

        expect(() => JSON.parse(fs.readFileSync(filePath, 'utf8').split('\n')[0])).toThrow();
    });

    test('never copies through a hard link when replacement renames stay locked', () => {
        const filePath = createTargetPath();
        const aliasPath = path.join(tempRoot, 'alias.jsonl');
        fs.writeFileSync(filePath, 'before', 'utf8');
        fs.linkSync(filePath, aliasPath);
        const checked = fs.statSync(filePath, { bigint: true });
        mockWritableTarget();
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw createWindowsFileLockError('EBUSY');
        });

        expect(() => tryWriteFileSync(filePath, 'after', 'utf8', {
            expectedFileIdentity: { dev: checked.dev, ino: checked.ino },
            replaceFileOnly: true,
        })).toThrow('EBUSY');

        expect(fs.readFileSync(filePath, 'utf8')).toBe('before');
        expect(fs.readFileSync(aliasPath, 'utf8')).toBe('before');
        expect(fs.statSync(filePath).ino).toBe(fs.statSync(aliasPath).ino);
    });

    test('does not follow or delete a pre-existing replacement temp link', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'before', 'utf8');
        const checked = fs.statSync(filePath, { bigint: true });
        jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.alloc(8, 1));
        const tempPath = `${filePath}.${process.pid}.${Buffer.alloc(8, 1).toString('hex')}.tmp`;
        fs.linkSync(filePath, tempPath);

        expect(() => tryWriteFileSync(filePath, 'after', 'utf8', {
            expectedFileIdentity: { dev: checked.dev, ino: checked.ino },
            replaceFileOnly: true,
        })).toThrow();

        expect(fs.readFileSync(filePath, 'utf8')).toBe('before');
        expect(fs.existsSync(tempPath)).toBe(true);
        expect(fs.statSync(filePath).ino).toBe(fs.statSync(tempPath).ino);
    });

    test('retries replace-only temp flushing with a fresh exclusive file', () => {
        const filePath = createTargetPath();
        const aliasPath = path.join(tempRoot, 'alias.jsonl');
        fs.writeFileSync(filePath, 'before', 'utf8');
        fs.linkSync(filePath, aliasPath);
        const checked = fs.statSync(filePath, { bigint: true });
        const fsyncSync = fs.fsyncSync.bind(fs);
        let failed = false;
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
            if (!failed) {
                failed = true;
                throw createWindowsFileLockError('EPERM');
            }
            return fsyncSync(fileDescriptor);
        });
        mockWritableTarget();

        tryWriteFileSync(filePath, 'after', 'utf8', {
            expectedFileIdentity: { dev: checked.dev, ino: checked.ino },
            replaceFileOnly: true,
        });

        expect(fs.readFileSync(filePath, 'utf8')).toBe('after');
        expect(fs.readFileSync(aliasPath, 'utf8')).toBe('before');
        expect(fs.readdirSync(tempRoot).filter(file => file.endsWith('.tmp'))).toHaveLength(0);
    });

    test('recovers every interrupted identity write in a directory', () => {
        const firstPath = createTargetPath();
        const secondPath = path.join(tempRoot, 'second.png');
        fs.writeFileSync(firstPath, 'first-original', 'utf8');
        fs.writeFileSync(secondPath, 'second-original', 'utf8');
        const unlinkSync = fs.unlinkSync.bind(fs);
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
            if (String(target).endsWith('.sillybunny-write-recovery')) {
                throw createWindowsFileLockError('EPERM');
            }
            return unlinkSync(target);
        });
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => tryWriteFileSync(firstPath, 'first-next', 'utf8', { preserveFileIdentity: true })).toThrow(/write recovery file/i);
        expect(() => tryWriteFileSync(secondPath, 'second-next', 'utf8', { preserveFileIdentity: true })).toThrow(/write recovery file/i);
        unlinkSpy.mockRestore();
        fs.writeFileSync(firstPath, 'first-partial', 'utf8');
        fs.writeFileSync(secondPath, 'second-partial', 'utf8');

        expect(recoverFileWritesInDirectorySync(tempRoot)).toBe(2);
        expect(fs.readFileSync(firstPath, 'utf8')).toBe('first-original');
        expect(fs.readFileSync(secondPath, 'utf8')).toBe('second-original');
    });

    test('restores an orphaned target from its interrupted-write record', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'original-card-content', 'utf8');
        const unlinkSync = fs.unlinkSync.bind(fs);
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
            if (String(target).endsWith('.sillybunny-write-recovery')) {
                throw createWindowsFileLockError('EPERM');
            }
            return unlinkSync(target);
        });
        expect(() => tryWriteFileSync(filePath, 'new-card-content', 'utf8', { preserveFileIdentity: true })).toThrow(/write recovery file/i);
        unlinkSpy.mockRestore();
        fs.unlinkSync(filePath);

        expect(recoverFileWritesInDirectorySync(tempRoot)).toBe(1);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('original-card-content');
    });

    test('does not overwrite a card recreated during orphan recovery', () => {
        const filePath = createTargetPath();
        fs.writeFileSync(filePath, 'original-card-content', 'utf8');
        const unlinkSync = fs.unlinkSync.bind(fs);
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
            if (String(target).endsWith('.sillybunny-write-recovery')) {
                throw createWindowsFileLockError('EPERM');
            }
            return unlinkSync(target);
        });
        expect(() => tryWriteFileSync(filePath, 'new-card-content', 'utf8', { preserveFileIdentity: true })).toThrow(/write recovery file/i);
        unlinkSpy.mockRestore();
        fs.unlinkSync(filePath);
        const linkSync = fs.linkSync.bind(fs);
        let recreated = false;
        jest.spyOn(fs, 'linkSync').mockImplementation((existingPath, newPath) => {
            if (!recreated && newPath === filePath) {
                recreated = true;
                fs.writeFileSync(filePath, 'concurrent-card-content', 'utf8');
            }
            return linkSync(existingPath, newPath);
        });

        expect(() => recoverFileWritesInDirectorySync(tempRoot)).toThrow(/replaced file/i);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('concurrent-card-content');
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
