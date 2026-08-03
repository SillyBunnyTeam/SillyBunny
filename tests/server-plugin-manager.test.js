import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

import {
    acquireServerPluginUpdateMutex,
    compareServerPluginVersions,
    discardStagedServerPluginRelease,
    getServerPluginReleaseDigest,
    getServerPluginUpdateCapabilities,
    runServerPluginCommand,
    SERVER_PLUGIN_RELEASE_MARKER,
    stageServerPluginRelease,
} from '../src/server-plugin-manager.js';
import { recoverInterruptedServerPluginUpdates } from '../src/server-plugin-update-helper.js';

const tempDirectories = [];

function createTempDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-server-plugin-manager-'));
    tempDirectories.push(directory);
    return directory;
}

function runGit(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    }
    return result.stdout.trim();
}

function packageLock(name, version) {
    return JSON.stringify({
        name,
        version,
        lockfileVersion: 3,
        requires: true,
        packages: {
            '': { name, version },
        },
    }, null, 2);
}

function writeRelease(sourcePath, repositoryUrl, version, { preservePaths = [], extraFile = '', markerSymlinkTarget = '' } = {}) {
    const packageJson = {
        name: 'example-server-plugin',
        version,
        type: 'module',
        main: 'index.js',
        repository: {
            type: 'git',
            url: repositoryUrl,
        },
        sillybunny: {
            serverPlugin: {
                id: 'example-server-plugin',
                preservePaths,
            },
        },
    };

    fs.writeFileSync(path.join(sourcePath, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    fs.writeFileSync(path.join(sourcePath, 'package-lock.json'), `${packageLock(packageJson.name, version)}\n`);
    fs.writeFileSync(path.join(sourcePath, 'index.js'), `export const version = '${version}';\n`);
    fs.writeFileSync(path.join(sourcePath, '.gitignore'), '.cursor-key\nnode_modules/\n.sillybunny-release.json\n');
    if (extraFile) {
        fs.writeFileSync(path.join(sourcePath, extraFile), version);
    }
    if (markerSymlinkTarget) {
        fs.symlinkSync(markerSymlinkTarget, path.join(sourcePath, SERVER_PLUGIN_RELEASE_MARKER));
    }
    runGit(sourcePath, 'add', '.');
    if (markerSymlinkTarget) {
        runGit(sourcePath, 'add', '--force', SERVER_PLUGIN_RELEASE_MARKER);
    }
    runGit(sourcePath, 'commit', '-m', `release ${version}`);
    runGit(sourcePath, 'tag', `v${version}`);
}

function createReleaseRepository({ markerSymlinkTarget = '' } = {}) {
    const root = createTempDirectory();
    const sourcePath = path.join(root, 'source');
    const remotePath = path.join(root, 'remote.git');
    const pluginsRoot = path.join(root, 'plugins');
    const pluginPath = path.join(pluginsRoot, 'ExamplePlugin');
    fs.mkdirSync(sourcePath);
    fs.mkdirSync(pluginsRoot);
    runGit(sourcePath, 'init', '--initial-branch=main');
    runGit(sourcePath, 'config', 'user.name', 'SillyBunny Tests');
    runGit(sourcePath, 'config', 'user.email', 'tests@example.invalid');
    runGit(root, 'init', '--bare', remotePath);

    const repositoryUrl = pathToFileURL(remotePath).href;
    writeRelease(sourcePath, repositoryUrl, '1.0.0', { extraFile: 'removed-in-v2.txt' });
    writeRelease(sourcePath, repositoryUrl, '2.0.0', { preservePaths: ['.cursor-key'], markerSymlinkTarget });
    runGit(sourcePath, 'remote', 'add', 'origin', repositoryUrl);
    runGit(sourcePath, 'push', 'origin', 'main', '--tags');
    runGit(root, 'clone', '--branch', 'v1.0.0', '--single-branch', repositoryUrl, pluginPath);
    fs.writeFileSync(path.join(pluginPath, '.cursor-key'), 'persistent-secret\n', { mode: 0o600 });

    return { root, pluginsRoot, pluginPath, repositoryUrl };
}

function markInstalledRelease(pluginPath, repositoryUrl) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(pluginPath, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(pluginPath, SERVER_PLUGIN_RELEASE_MARKER), JSON.stringify({
        schemaVersion: 1,
        packageName: packageJson.name,
        repository: repositoryUrl.replace(/\.git$/, ''),
        version: packageJson.version,
        tag: `v${packageJson.version}`,
        commit: runGit(pluginPath, 'rev-parse', 'HEAD'),
    }));
}

function testDependencies({ onCommand = () => { } } = {}) {
    return {
        allowFileRepositories: true,
        commandExists: () => true,
        runCommand: async (command, args, options) => {
            onCommand(command, args, options);
            if (command === 'npm' || command === 'npm.cmd') {
                return { stdout: '', stderr: '' };
            }
            return await runServerPluginCommand(command, args, options);
        },
    };
}

afterEach(() => {
    jest.restoreAllMocks();
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('server plugin release manager', () => {
    test('compares only stable release versions', () => {
        expect(compareServerPluginVersions('2.0.0', '1.9.9')).toBe(1);
        expect(compareServerPluginVersions('1.0.0', '1.0.0')).toBe(0);
        expect(compareServerPluginVersions('0.9.0', '1.0.0')).toBe(-1);
        expect(compareServerPluginVersions('1.0.0-beta.1', '1.0.0')).toBeNull();
    });

    test('advertises exact updates only when Git and npm are available', () => {
        expect(getServerPluginUpdateCapabilities({ commandExists: () => true, supervised: true })).toMatchObject({
            apiVersion: 1,
            exactGitRelease: true,
            existingPluginsOnly: true,
            available: true,
        });
        expect(getServerPluginUpdateCapabilities({ commandExists: command => command === 'git', supervised: true })).toMatchObject({
            available: false,
            tooling: { git: true, npm: false },
        });
    });

    test('preserves timed-out command state when process termination cannot be confirmed', async () => {
        const child = new EventEmitter();
        child.pid = 123;
        child.kill = jest.fn();
        const spawnFn = jest.fn(command => {
            if (command !== 'taskkill.exe') {
                return child;
            }

            const killer = new EventEmitter();
            queueMicrotask(() => {
                killer.emit('error', new Error('taskkill failed'));
                queueMicrotask(() => child.emit('error', new Error('child teardown failed')));
            });
            return killer;
        });

        await expect(runServerPluginCommand('npm.cmd', ['ci'], {
            cwd: process.cwd(),
            timeoutMs: 1,
            platform: 'win32',
            spawnFn,
        })).rejects.toMatchObject({
            serverPluginCommandTerminationUnconfirmed: true,
        });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    test('stages an exact tag, production dependencies, pin metadata, and deferred preserved state', async () => {
        const { pluginsRoot, pluginPath } = createReleaseRepository();
        const commands = [];
        const staged = await stageServerPluginRelease({
            pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies({ onCommand: (command, args) => commands.push([command, args]) }));

        expect(staged).toMatchObject({
            action: 'updated',
            currentVersion: '1.0.0',
            targetVersion: '2.0.0',
            tag: 'v2.0.0',
            restarting: true,
        });
        expect(staged.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(staged.releaseDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(commands).toContainEqual(['npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']]);
        expect(JSON.parse(fs.readFileSync(staged.lockPath, 'utf8'))).toMatchObject({
            schemaVersion: 1,
            transactionId: staged.transactionId,
        });
        expect(JSON.parse(fs.readFileSync(staged.journalPath, 'utf8'))).toMatchObject({
            schemaVersion: 1,
            state: 'staged',
            transactionId: staged.transactionId,
            releaseDigest: staged.releaseDigest,
        });
        expect(JSON.parse(fs.readFileSync(path.join(staged.releaseRoot, 'package.json'), 'utf8')).version).toBe('2.0.0');
        expect(fs.existsSync(path.join(staged.releaseRoot, '.cursor-key'))).toBe(false);
        expect(staged).toMatchObject({
            expectedPluginId: 'example-server-plugin',
            preservePaths: ['.cursor-key'],
        });
        expect(JSON.parse(fs.readFileSync(path.join(staged.releaseRoot, SERVER_PLUGIN_RELEASE_MARKER), 'utf8'))).toMatchObject({
            version: '2.0.0',
            tag: 'v2.0.0',
            commit: staged.commit,
        });
        expect(JSON.parse(fs.readFileSync(path.join(pluginPath, 'package.json'), 'utf8')).version).toBe('1.0.0');

        discardStagedServerPluginRelease(staged);
        expect(fs.existsSync(staged.stagingRoot)).toBe(false);
        expect(fs.existsSync(staged.lockPath)).toBe(false);
        expect(fs.existsSync(staged.journalPath)).toBe(false);
    });

    test('refuses to update a symlink-managed plugin', async () => {
        const root = createTempDirectory();
        const pluginsRoot = path.join(root, 'plugins');
        const externalPlugin = path.join(root, 'external-plugin');
        fs.mkdirSync(pluginsRoot);
        fs.mkdirSync(externalPlugin);
        fs.symlinkSync(externalPlugin, path.join(pluginsRoot, 'ExamplePlugin'), 'dir');

        await expect(stageServerPluginRelease({
            pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies())).rejects.toMatchObject({
            status: 409,
            code: 'managed_externally',
        });
    });

    test('refuses symlinked updater storage', async () => {
        const { root, pluginsRoot } = createReleaseRepository();
        const external = path.join(root, 'external-updates');
        fs.mkdirSync(external);
        fs.symlinkSync(external, path.join(pluginsRoot, '.server-plugin-updates'), 'dir');

        await expect(stageServerPluginRelease({
            pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies())).rejects.toMatchObject({
            status: 409,
            code: 'managed_externally',
        });
    });

    test('does not stage while supervisor recovery owns the plugin root', async () => {
        const { pluginsRoot } = createReleaseRepository();
        const updatesRoot = path.join(pluginsRoot, '.server-plugin-updates');
        fs.mkdirSync(updatesRoot);
        const releaseMutex = acquireServerPluginUpdateMutex(updatesRoot);
        try {
            await expect(stageServerPluginRelease({
                pluginsRoot,
                directoryName: 'ExamplePlugin',
                targetVersion: '2.0.0',
            }, testDependencies())).rejects.toMatchObject({
                status: 409,
                code: 'update_busy',
            });
        } finally {
            releaseMutex();
        }
    });

    test('rejects release symlinks before writing release metadata', async () => {
        const repository = createReleaseRepository({ markerSymlinkTarget: '../outside.txt' });

        await expect(stageServerPluginRelease({
            pluginsRoot: repository.pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies())).rejects.toMatchObject({
            status: 422,
            code: 'unsafe_release',
        });
        expect(fs.existsSync(path.join(repository.root, 'outside.txt'))).toBe(false);
    });

    test('rejects absolute dependency symlinks that would break after activation', () => {
        const releaseRoot = createTempDirectory();
        const target = path.join(releaseRoot, 'node_modules', 'target');
        const link = path.join(releaseRoot, 'node_modules', 'linked');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'index.js'), 'export default true;\n');
        fs.symlinkSync(target, link, 'dir');

        expect(() => getServerPluginReleaseDigest(releaseRoot)).toThrow('unsafe symbolic link');
    });

    test('refuses dirty tracked files and downgrades', async () => {
        const dirtyRepository = createReleaseRepository();
        fs.appendFileSync(path.join(dirtyRepository.pluginPath, 'index.js'), '// local change\n');

        await expect(stageServerPluginRelease({
            pluginsRoot: dirtyRepository.pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies())).rejects.toMatchObject({
            status: 409,
            code: 'dirty_checkout',
        });

        const downgradeRepository = createReleaseRepository();
        await expect(stageServerPluginRelease({
            pluginsRoot: downgradeRepository.pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '0.9.0',
        }, testDependencies())).rejects.toMatchObject({
            status: 409,
            code: 'downgrade_blocked',
        });
    });

    test.each([
        ['ssh://git@example.com/Owner/Repo.git', 'ssh://mallory@example.com/Owner/Repo.git'],
        ['https://example.com/Owner/Repo.git', 'https://example.com:8443/Owner/Repo.git'],
        ['https://example.com/Owner/Repo.git', 'https://example.com/owner/repo.git'],
    ])('does not collapse distinct repository identities (%s)', async (declaredRepository, originRepository) => {
        const repository = createReleaseRepository();
        const packagePath = path.join(repository.pluginPath, 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        packageJson.repository.url = declaredRepository;
        fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
        runGit(repository.pluginPath, 'add', 'package.json');
        runGit(repository.pluginPath, 'commit', '-m', 'set repository identity');
        runGit(repository.pluginPath, 'remote', 'set-url', 'origin', originRepository);

        // eslint-disable-next-line playwright/no-standalone-expect
        await expect(stageServerPluginRelease({
            pluginsRoot: repository.pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies())).rejects.toMatchObject({
            status: 409,
            code: 'wrong_remote',
        });
    });

    test('returns unchanged without leaving an update lock', async () => {
        const { pluginsRoot, pluginPath, repositoryUrl } = createReleaseRepository();
        markInstalledRelease(pluginPath, repositoryUrl);
        const result = await stageServerPluginRelease({
            pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '1.0.0',
        }, testDependencies());

        expect(result).toMatchObject({ action: 'unchanged', restarting: false });
        expect(fs.existsSync(path.join(pluginsRoot, '.server-plugin-updates', 'active.lock'))).toBe(false);
    });

    test('requires supervisor recovery for a malformed pre-journal lock', async () => {
        const repository = createReleaseRepository();
        const updatesRoot = path.join(repository.pluginsRoot, '.server-plugin-updates');
        const lockPath = path.join(updatesRoot, 'active.lock');
        fs.mkdirSync(updatesRoot);
        fs.writeFileSync(lockPath, '{');
        await expect(stageServerPluginRelease({
            pluginsRoot: repository.pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies())).rejects.toMatchObject({ code: 'update_busy' });

        expect(recoverInterruptedServerPluginUpdates(repository.pluginsRoot)).toEqual([]);

        const staged = await stageServerPluginRelease({
            pluginsRoot: repository.pluginsRoot,
            directoryName: 'ExamplePlugin',
            targetVersion: '2.0.0',
        }, testDependencies());

        expect(staged.action).toBe('updated');
        discardStagedServerPluginRelease(staged);
    });

    test('reinstalls an unpinned checkout even when package.json already has the target version', async () => {
        const { pluginsRoot } = createReleaseRepository();
        const staged = await stageServerPluginRelease({
            pluginsRoot,
            directoryName: ' ExamplePlugin ',
            targetVersion: '1.0.0',
        }, testDependencies());

        expect(staged).toMatchObject({
            action: 'updated',
            directoryName: 'ExamplePlugin',
            currentVersion: '1.0.0',
            targetVersion: '1.0.0',
        });
        discardStagedServerPluginRelease(staged);
    });
});
