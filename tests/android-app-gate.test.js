/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { checkAndroidAppGate, isAndroidApp } from '../src/android-app-gate.js';

const ENV_KEYS = [
    'SILLYBUNNY_ANDROID_APP',
    'SILLYBUNNY_ANDROID_APP_VERSION_CODE',
    'SILLYBUNNY_ANDROID_STATUS_DIR',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const tempDirectories = [];
const REF = 'origin/staging';
const BRANCH = 'staging';
const UPSTREAM = '0123456789abcdef0123456789abcdef01234567';

function createGit(required = '1\n') {
    return {
        show: jest.fn().mockResolvedValue(required),
        revparse: jest.fn().mockResolvedValue(`${UPSTREAM}\n`),
    };
}

async function createTempDirectory() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-android-gate-'));
    tempDirectories.push(directory);
    return directory;
}

beforeEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
});

afterEach(async () => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalEnv[key];
        }
    }
    for (const directory of tempDirectories.splice(0)) {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

describe('Android app update gate', () => {
    test.each([undefined, '', '0', 'true', '2'])('is inert when APK mode is %s', async mode => {
        if (mode !== undefined) {
            process.env.SILLYBUNNY_ANDROID_APP = mode;
        }
        const directory = await createTempDirectory();
        const statusPath = path.join(directory, 'update-blocked.json');
        await fs.writeFile(statusPath, 'existing status\n');
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        const git = createGit('2');
        const diskCalls = ['mkdir', 'writeFile', 'rename', 'rm'].map(method => jest.spyOn(fs, method));

        expect(isAndroidApp()).toBe(false);
        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false });
        expect(git.show).not.toHaveBeenCalled();
        expect(git.revparse).not.toHaveBeenCalled();
        for (const diskCall of diskCalls) {
            expect(diskCall).not.toHaveBeenCalled();
        }
        expect(await fs.readFile(statusPath, 'utf8')).toBe('existing status\n');
    });

    test.each(['1', '2'])('allows required version %s with installed version 2', async required => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '2';
        const git = createGit(` \n${required}\n `);

        expect(isAndroidApp()).toBe(true);
        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
        expect(git.revparse).toHaveBeenCalledWith([REF]);
        expect(git.show).toHaveBeenCalledWith([`${UPSTREAM}:android/min-app-version`]);
        expect(git.revparse.mock.invocationCallOrder[0]).toBeLessThan(git.show.mock.invocationCallOrder[0]);
    });

    test('blocks code requiring a newer APK and resolves the checked commit', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '1';
        const git = createGit('2\n');

        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toEqual({
            blocked: true,
            required: 2,
            installed: 1,
            reason: 'newer',
            upstream: UPSTREAM,
        });
        expect(git.show).toHaveBeenCalledWith([`${UPSTREAM}:android/min-app-version`]);
        expect(git.revparse).toHaveBeenCalledWith([REF]);
    });

    test('does not allow a newer integer merely because number conversion rounds it down', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '9007199254740992';

        await expect(checkAndroidAppGate(createGit('9007199254740993'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({
            blocked: true,
            reason: 'newer',
        });
    });

    test('blocks refs without an Android minimum version', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '10';
        const git = createGit();
        git.show.mockRejectedValue(new Error('missing file or ref'));

        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toEqual({
            blocked: true,
            required: null,
            installed: 10,
            reason: 'missing',
            upstream: UPSTREAM,
        });
    });

    test.each(['', 'abc', '1.5', '-1', '2 3', ' \n\t'])('blocks invalid minimum version %j', async required => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '10';

        await expect(checkAndroidAppGate(createGit(required), { ref: REF, branch: BRANCH })).resolves.toEqual({
            blocked: true,
            required: null,
            installed: 10,
            reason: 'invalid',
            upstream: UPSTREAM,
        });
    });

    test.each([undefined, '', 'garbage', '1.5', '-1', '2 3', ' 2', '2\n'])('uses installed version 0 for %j', async installed => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        if (installed !== undefined) {
            process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = installed;
        }

        await expect(checkAndroidAppGate(createGit('1'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({
            blocked: true,
            required: 1,
            installed: 0,
            reason: 'newer',
        });
    });

    test.each(['0', '0002'])('accepts installed integer string %j', async installed => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = installed;

        await expect(checkAndroidAppGate(createGit('0'), { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
    });

    test.each(['0', '2'])('blocks an unresolved ref before reading its minimum (%s)', async required => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        const directory = await createTempDirectory();
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        const git = createGit(required);
        git.revparse.mockRejectedValue(new Error('unknown ref'));

        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toEqual({
            blocked: true,
            required: null,
            installed: 0,
            reason: 'missing',
            upstream: null,
        });
        expect(git.revparse).toHaveBeenCalledTimes(1);
        expect(git.show).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(directory, 'update-blocked.json'))).toEqual(Buffer.from('{"required":null,"installed":0,"reason":"missing","upstream":null,"branch":"staging"}\n'));
    });

    test('returns the checked commit even when a ref moves while reading the minimum', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '1';
        let currentCommit = UPSTREAM;
        const git = createGit();
        git.revparse.mockImplementation(async () => currentCommit);
        git.show.mockImplementation(async () => {
            currentCommit = 'ffffffffffffffffffffffffffffffffffffffff';
            return '1';
        });

        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
        expect(git.revparse).toHaveBeenCalledTimes(1);
        expect(git.show).toHaveBeenCalledWith([`${UPSTREAM}:android/min-app-version`]);
        expect(currentCommit).toBe('ffffffffffffffffffffffffffffffffffffffff');
    });

    test('records the checked commit rather than the moved ref in blocked status', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '1';
        const directory = await createTempDirectory();
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        let currentCommit = UPSTREAM;
        const git = createGit();
        git.revparse.mockImplementation(async () => currentCommit);
        git.show.mockImplementation(async () => {
            currentCommit = 'ffffffffffffffffffffffffffffffffffffffff';
            return '2';
        });

        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true, upstream: UPSTREAM });
        expect(git.revparse).toHaveBeenCalledTimes(1);
        expect(git.show).toHaveBeenCalledWith([`${UPSTREAM}:android/min-app-version`]);
        expect(await fs.readFile(path.join(directory, 'update-blocked.json'))).toEqual(Buffer.from('{"required":2,"installed":1,"reason":"newer","upstream":"0123456789abcdef0123456789abcdef01234567","branch":"staging"}\n'));
    });

    test.each([undefined, ''])('does not access disk without a status directory (%s)', async statusDirectory => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        if (statusDirectory !== undefined) {
            process.env.SILLYBUNNY_ANDROID_STATUS_DIR = statusDirectory;
        }
        const diskCalls = ['mkdir', 'writeFile', 'rename', 'rm'].map(method => jest.spyOn(fs, method));

        await expect(checkAndroidAppGate(createGit('2'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true });
        await expect(checkAndroidAppGate(createGit('0'), { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
        for (const diskCall of diskCalls) {
            expect(diskCall).not.toHaveBeenCalled();
        }
    });

    test('atomically writes the exact blocked status bytes, then removes the status on pass', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '1';
        const directory = path.join(await createTempDirectory(), 'status');
        const statusPath = path.join(directory, 'update-blocked.json');
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        const rename = fs.rename.bind(fs);
        const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
            expect(path.dirname(source)).toBe(directory);
            expect(source).not.toBe(statusPath);
            expect(target).toBe(statusPath);
            expect(await fs.readFile(source)).toEqual(Buffer.from('{"required":2,"installed":1,"reason":"newer","upstream":"0123456789abcdef0123456789abcdef01234567","branch":"staging"}\n'));
            await expect(fs.readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
            await rename(source, target);
        });

        await expect(checkAndroidAppGate(createGit('2'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true });
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(statusPath)).toEqual(Buffer.from('{"required":2,"installed":1,"reason":"newer","upstream":"0123456789abcdef0123456789abcdef01234567","branch":"staging"}\n'));
        expect(await fs.readdir(directory)).toEqual(['update-blocked.json']);

        await expect(checkAndroidAppGate(createGit('1'), { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
        await expect(fs.readFile(statusPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readdir(directory)).toEqual([]);
        await expect(checkAndroidAppGate(createGit('0'), { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
    });

    test('atomically replaces an existing blocked status without leaving temporary files', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '1';
        const directory = await createTempDirectory();
        const statusPath = path.join(directory, 'update-blocked.json');
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        await fs.writeFile(statusPath, 'previous status\n');

        await expect(checkAndroidAppGate(createGit('3'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true });
        expect(await fs.readFile(statusPath)).toEqual(Buffer.from('{"required":3,"installed":1,"reason":"newer","upstream":"0123456789abcdef0123456789abcdef01234567","branch":"staging"}\n'));
        expect(await fs.readdir(directory)).toEqual(['update-blocked.json']);
    });

    test.each([
        ['missing', '{"required":null,"installed":1,"reason":"missing","upstream":"0123456789abcdef0123456789abcdef01234567","branch":"staging"}\n'],
        ['invalid', '{"required":null,"installed":1,"reason":"invalid","upstream":"0123456789abcdef0123456789abcdef01234567","branch":"staging"}\n'],
    ])('writes null required version for %s status', async (reason, expected) => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '1';
        const directory = await createTempDirectory();
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        const git = createGit('invalid');
        if (reason === 'missing') {
            git.show.mockRejectedValue(new Error('missing file'));
        }
        await expect(checkAndroidAppGate(git, { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true, reason });
        expect(await fs.readFile(path.join(directory, 'update-blocked.json'))).toEqual(Buffer.from(expected));
    });

    test('logs an unwritable status directory without rejecting', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        const statusDirectory = path.join(await createTempDirectory(), 'not-a-directory');
        await fs.writeFile(statusDirectory, 'keep\n');
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = statusDirectory;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(checkAndroidAppGate(createGit('2'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true });
        expect(warn).toHaveBeenCalledTimes(1);
        await expect(checkAndroidAppGate(createGit('0'), { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
        expect(await fs.readFile(statusDirectory, 'utf8')).toBe('keep\n');
    });

    test('logs status removal failures without rejecting an allowed update', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        const directory = await createTempDirectory();
        const statusPath = path.join(directory, 'update-blocked.json');
        await fs.writeFile(statusPath, 'keep\n');
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        jest.spyOn(fs, 'rm').mockRejectedValue(failure);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(checkAndroidAppGate(createGit('0'), { ref: REF, branch: BRANCH })).resolves.toEqual({ blocked: false, commit: UPSTREAM });
        expect(warn).toHaveBeenCalledWith('lorum ipsum', failure);
        expect(await fs.readFile(statusPath, 'utf8')).toBe('keep\n');
    });

    test('keeps the previous status and cleans up temporary files when rename fails', async () => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        const directory = await createTempDirectory();
        const statusPath = path.join(directory, 'update-blocked.json');
        await fs.writeFile(statusPath, 'keep\n');
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        jest.spyOn(fs, 'rename').mockRejectedValue(failure);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(checkAndroidAppGate(createGit('2'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true });
        expect(warn).toHaveBeenCalledWith('lorum ipsum', failure);
        expect(await fs.readFile(statusPath, 'utf8')).toBe('keep\n');
        expect(await fs.readdir(directory)).toEqual(['update-blocked.json']);
    });

    test.each([false, true])('keeps the previous status when a partial write fails (cleanup failure: %s)', async cleanupFails => {
        process.env.SILLYBUNNY_ANDROID_APP = '1';
        const directory = await createTempDirectory();
        const statusPath = path.join(directory, 'update-blocked.json');
        process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
        await fs.writeFile(statusPath, 'previous status\n');
        const failure = Object.assign(new Error('partial write failed'), { code: 'ENOSPC' });
        const writeFile = fs.writeFile.bind(fs);
        let temporaryPath;
        jest.spyOn(fs, 'writeFile').mockImplementation(async filePath => {
            temporaryPath = filePath;
            await writeFile(filePath, '{');
            throw failure;
        });
        const cleanupFailure = Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
        if (cleanupFails) {
            jest.spyOn(fs, 'rm').mockRejectedValue(cleanupFailure);
        }
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(checkAndroidAppGate(createGit('2'), { ref: REF, branch: BRANCH })).resolves.toMatchObject({ blocked: true });
        expect(warn.mock.calls).toEqual(cleanupFails
            ? [['lorum ipsum', failure], ['lorum ipsum', cleanupFailure]]
            : [['lorum ipsum', failure]]);
        expect(await fs.readFile(statusPath, 'utf8')).toBe('previous status\n');
        expect((await fs.readdir(directory)).sort()).toEqual(cleanupFails
            ? [path.basename(temporaryPath), 'update-blocked.json'].sort()
            : ['update-blocked.json']);
    });
});
