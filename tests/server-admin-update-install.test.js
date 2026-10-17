import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NPM_INSTALL_ARGS = ['ci', '--no-audit', '--no-fund', '--omit=dev'];
const NPM_INSTALL_COMMAND = 'npm ci --no-audit --no-fund --omit=dev';
const tempDirectories = [];
let configDirectory;
let installUpdateDependencies;

function createTempDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-update-install-'));
    tempDirectories.push(directory);
    return directory;
}

function createProject({ bunLock = false, packageLock = true } = {}) {
    const directory = createTempDirectory();
    const name = 'sillybunny-update-install-fixture';
    fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', private: true }, null, 2)}\n`);
    if (packageLock) {
        fs.writeFileSync(path.join(directory, 'package-lock.json'), `${JSON.stringify({
            name,
            version: '1.0.0',
            lockfileVersion: 3,
            requires: true,
            packages: { '': { name, version: '1.0.0' } },
        }, null, 2)}\n`);
    }
    if (bunLock) {
        fs.writeFileSync(path.join(directory, 'bun.lock'), '');
    }
    return directory;
}

function createNpmCli() {
    const npmCli = path.join(createTempDirectory(), 'npm-cli.js');
    fs.writeFileSync(npmCli, '');
    return npmCli;
}

// Hides every npm-cli.js, including the one installed next to the running Node binary.
function hideNpmCli() {
    const existsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation(filePath => path.basename(String(filePath)) !== 'npm-cli.js' && existsSync(filePath));
}

function recordRuns(calls) {
    return async (command, args, options) => {
        calls.push([command, args, options.cwd]);
        return { stdout: `${command} ok`, stderr: '' };
    };
}

beforeAll(async () => {
    configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-update-install-config-'));
    const configPath = path.join(configDirectory, 'config.yaml');
    fs.writeFileSync(configPath, '{}\n');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(configPath);
    ({ installUpdateDependencies } = await import('../src/endpoints/server-admin.js'));
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

afterAll(() => {
    fs.rmSync(configDirectory, { recursive: true, force: true });
});

describe('self-update dependency install', () => {
    test('runs npm-cli.js with Node on Windows and still reports the npm command', async () => {
        const directory = createProject();
        const npmCli = createNpmCli();
        const calls = [];

        const install = await installUpdateDependencies({
            directory,
            platform: 'win32',
            env: { npm_execpath: npmCli },
            bunRuntime: false,
            commandExists: command => command !== 'bun',
            run: recordRuns(calls),
        });

        expect(calls).toEqual([
            [process.execPath, [npmCli, ...NPM_INSTALL_ARGS], directory],
            ['git', ['restore', '--', 'package-lock.json'], directory],
        ]);
        expect(install).toEqual({ command: NPM_INSTALL_COMMAND, stdout: `${process.execPath} ok`, stderr: '' });
    });

    test('fails before spawning anything when Windows Node has no npm-cli.js', async () => {
        const directory = createProject();
        const calls = [];
        hideNpmCli();

        await expect(installUpdateDependencies({
            directory,
            platform: 'win32',
            env: {},
            bunRuntime: false,
            commandExists: command => command !== 'bun',
            run: recordRuns(calls),
        })).rejects.toThrow('Cannot locate npm-cli.js');
        expect(calls).toEqual([]);
    });

    test('keeps bare npm under Bun on Windows, which resolves npm.cmd itself', async () => {
        const directory = createProject();
        const calls = [];

        await installUpdateDependencies({
            directory,
            platform: 'win32',
            env: {},
            bunRuntime: true,
            commandExists: command => command !== 'bun',
            run: recordRuns(calls),
        });

        expect(calls[0]).toEqual(['npm', NPM_INSTALL_ARGS, directory]);
    });

    test('runs npm directly outside Windows', async () => {
        const directory = createProject();
        const calls = [];

        const install = await installUpdateDependencies({
            directory,
            platform: 'linux',
            env: {},
            bunRuntime: false,
            commandExists: command => command !== 'bun',
            run: recordRuns(calls),
        });

        expect(calls).toEqual([
            ['npm', NPM_INSTALL_ARGS, directory],
            ['git', ['restore', '--', 'package-lock.json'], directory],
        ]);
        expect(install.command).toBe(NPM_INSTALL_COMMAND);
    });

    test('keeps bun install when Bun is available', async () => {
        const directory = createProject({ bunLock: true });
        const calls = [];

        const install = await installUpdateDependencies({
            directory,
            platform: 'win32',
            env: {},
            bunRuntime: false,
            commandExists: () => true,
            run: recordRuns(calls),
        });

        expect(calls).toEqual([['bun', ['install'], directory]]);
        expect(install.command).toBe('bun install');
    });

    test('skips the install when neither Bun nor npm is available', async () => {
        const calls = [];

        await expect(installUpdateDependencies({
            directory: createProject(),
            platform: 'win32',
            env: {},
            bunRuntime: false,
            commandExists: () => false,
            run: recordRuns(calls),
        })).resolves.toBeNull();
        expect(calls).toEqual([]);
    });

    test('skips npm when the checkout has no package-lock.json', async () => {
        const calls = [];

        await expect(installUpdateDependencies({
            directory: createProject({ packageLock: false }),
            platform: 'linux',
            env: {},
            bunRuntime: false,
            commandExists: command => command !== 'bun',
            run: recordRuns(calls),
        })).resolves.toBeNull();
        expect(calls).toEqual([]);
    });

    test('skips the lockfile restore when Git is not available', async () => {
        const directory = createProject();
        const calls = [];

        await installUpdateDependencies({
            directory,
            platform: 'linux',
            env: {},
            bunRuntime: false,
            commandExists: command => command === 'npm',
            run: recordRuns(calls),
        });

        expect(calls).toEqual([['npm', NPM_INSTALL_ARGS, directory]]);
    });

    test('keeps the install result when the lockfile restore fails', async () => {
        const directory = createProject();
        const recordRun = recordRuns([]);

        const install = await installUpdateDependencies({
            directory,
            platform: 'linux',
            env: {},
            bunRuntime: false,
            commandExists: command => command !== 'bun',
            run: async (command, args, options) => {
                if (command === 'git') {
                    throw new Error('git restore failed');
                }
                return await recordRun(command, args, options);
            },
        });

        expect(install).toEqual({ command: NPM_INSTALL_COMMAND, stdout: 'npm ok', stderr: '' });
    });
});
