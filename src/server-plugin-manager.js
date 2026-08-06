import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { sync as commandExistsSync } from 'command-exists';

import { isPathInside } from './path-containment.js';
import { isServerPluginUpdateSupervised } from './server-plugin-update-ipc.js';

const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile');

export const SERVER_PLUGIN_UPDATE_API_VERSION = 1;
export const SERVER_PLUGIN_RELEASE_MARKER = '.sillybunny-release.json';
export const SERVER_PLUGIN_UPDATE_DIRECTORY = '.server-plugin-updates';
export const SERVER_PLUGIN_BACKUP_DIRECTORY = '.server-plugin-backups';
export const SERVER_PLUGIN_UPDATE_MUTEX = '.transaction-mutex';

const UPDATE_LOCK_NAME = 'active.lock';
const DIRECTORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9_-]+$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_COMMAND_OUTPUT = 32 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PRESERVE_PATHS = 16;
const UPDATE_MUTEX_STALE_MS = 5 * 60 * 1000;
const JOURNAL_SUFFIX = '.jsonl';
const BLOCKED_PRESERVE_ROOTS = new Set(['.git', 'node_modules', SERVER_PLUGIN_RELEASE_MARKER]);
const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']);

export class ServerPluginUpdateError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ServerPluginUpdateError';
        this.status = status;
        this.code = code;
    }
}

function fail(status, code, message) {
    throw new ServerPluginUpdateError(status, code, message);
}

function readPackageJson(packagePath, description) {
    let stat;

    try {
        stat = fs.lstatSync(packagePath);
    } catch {
        fail(422, 'invalid_package', `${description} does not contain package.json.`);
    }

    if (!stat.isFile() || stat.isSymbolicLink()) {
        fail(422, 'invalid_package', `${description} package.json must be a regular file.`);
    }

    try {
        return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch {
        fail(422, 'invalid_package', `${description} package.json is invalid.`);
    }
}

function getRepositoryValue(packageJson) {
    return typeof packageJson?.repository === 'string'
        ? packageJson.repository
        : packageJson?.repository?.url;
}

function normalizeRepositoryUrl(value, { allowFileRepositories = false } = {}) {
    let raw = String(value ?? '').trim().replace(/^git\+/, '');

    if (!raw) {
        return null;
    }

    const scpMatch = raw.match(/^([^@]+)@([^:]+):(.+)$/);
    if (scpMatch) {
        raw = `ssh://${scpMatch[1]}@${scpMatch[2]}/${scpMatch[3]}`;
    }

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }

    const allowedProtocols = new Set(['https:', 'ssh:']);
    if (allowFileRepositories) {
        allowedProtocols.add('file:');
    }

    if (
        !allowedProtocols.has(parsed.protocol)
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
        || (parsed.protocol === 'https:' && parsed.username)
        || (parsed.protocol === 'ssh:' && parsed.username !== 'git')
    ) {
        return null;
    }

    let repositoryPath;
    try {
        repositoryPath = decodeURIComponent(parsed.pathname)
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\.git$/, '');
    } catch {
        return null;
    }

    const repositoryParts = repositoryPath.split('/');
    if (
        !repositoryPath
        || (parsed.protocol !== 'file:' && !parsed.hostname)
        || repositoryPath.includes('\0')
        || repositoryParts.some(part => !part || part === '.' || part === '..')
    ) {
        return null;
    }

    return parsed.protocol === 'file:'
        ? `file:///${repositoryPath}`
        : `${parsed.hostname.toLowerCase()}/${repositoryPath}`;
}

function parseVersion(value) {
    const version = String(value ?? '').trim();
    const match = version.match(VERSION_PATTERN);
    return match ? match.slice(1).map(part => Number.parseInt(part, 10)) : null;
}

export function compareServerPluginVersions(left, right) {
    const leftParts = parseVersion(left);
    const rightParts = parseVersion(right);

    if (!leftParts || !rightParts) {
        return null;
    }

    for (let index = 0; index < leftParts.length; index++) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] > rightParts[index] ? 1 : -1;
        }
    }

    return 0;
}

function truncateOutput(value) {
    const text = String(value ?? '').trim();
    return text.length > MAX_COMMAND_OUTPUT
        ? `${text.slice(0, MAX_COMMAND_OUTPUT - 1).trimEnd()}\n…`
        : text;
}

function syncRegularFile(filePath) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

export function syncServerPluginDirectory(directoryPath) {
    let descriptor;
    try {
        descriptor = fs.openSync(directoryPath, 'r');
        fs.fsyncSync(descriptor);
    } catch (error) {
        if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error?.code)) {
            throw error;
        }
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}

export function syncServerPluginTree(targetPath) {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
        return;
    }
    if (stat.isFile()) {
        syncRegularFile(targetPath);
        return;
    }
    if (!stat.isDirectory()) {
        fail(422, 'unsafe_release', `Server plugin release contains an unsupported file type: ${targetPath}.`);
    }
    for (const entry of fs.readdirSync(targetPath)) {
        syncServerPluginTree(path.join(targetPath, entry));
    }
    syncServerPluginDirectory(targetPath);
}

function writeDurableFile(filePath, contents, options = {}) {
    const descriptor = fs.openSync(filePath, options.flag ?? 'w', options.mode ?? 0o600);
    try {
        fs.writeFileSync(descriptor, contents);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    syncServerPluginDirectory(path.dirname(filePath));
}

export async function runServerPluginCommand(command, args, {
    cwd,
    timeoutMs = COMMAND_TIMEOUT_MS,
    spawnFn = spawn,
    platform = process.platform,
} = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawnFn(command, args, {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timeoutError = null;
        let forceSettleTimer = null;
        let terminationUnconfirmed = false;
        const timer = setTimeout(() => {
            timeoutError = new Error(`${command} timed out.`);
            if (platform === 'win32' && child.pid) {
                terminationUnconfirmed = true;
                const killer = spawnFn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
                    stdio: 'ignore',
                    windowsHide: true,
                });
                killer.once('error', () => child.kill('SIGKILL'));
                killer.once('close', code => {
                    if (code === 0) {
                        terminationUnconfirmed = false;
                    } else {
                        child.kill('SIGKILL');
                    }
                });
            } else if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    terminationUnconfirmed = true;
                    child.kill('SIGKILL');
                }
            } else {
                terminationUnconfirmed = true;
            }
            forceSettleTimer = setTimeout(() => {
                timeoutError.serverPluginCommandTerminationUnconfirmed = true;
                finish(timeoutError);
            }, 10_000);
            forceSettleTimer.unref?.();
        }, timeoutMs);

        timer.unref?.();

        child.stdout?.on('data', chunk => {
            if (stdout.length < MAX_COMMAND_OUTPUT) {
                stdout += String(chunk).slice(0, MAX_COMMAND_OUTPUT - stdout.length);
            }
        });
        child.stderr?.on('data', chunk => {
            if (stderr.length < MAX_COMMAND_OUTPUT) {
                stderr += String(chunk).slice(0, MAX_COMMAND_OUTPUT - stderr.length);
            }
        });

        child.once('error', error => {
            if (!timeoutError) {
                finish(error);
                return;
            }

            timeoutError.serverPluginCommandTerminationUnconfirmed = true;
            finish(timeoutError);
        });
        child.once('close', code => {
            if (timeoutError) {
                if (terminationUnconfirmed) {
                    timeoutError.serverPluginCommandTerminationUnconfirmed = true;
                }
                finish(timeoutError);
                return;
            }
            if (code === 0) {
                finish(null, { stdout: truncateOutput(stdout), stderr: truncateOutput(stderr) });
                return;
            }

            finish(new Error(truncateOutput(stderr || stdout || `${command} failed with exit code ${code}.`)));
        });

        function finish(error, result) {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            clearTimeout(forceSettleTimer);
            error ? reject(error) : resolve(result);
        }
    });
}

function readUpdateLock(lockPath) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (
        lock?.schemaVersion !== 1
        || !/^[0-9a-f-]{36}$/i.test(String(lock?.transactionId ?? ''))
        || !Number.isInteger(lock?.pid)
        || lock.pid <= 0
    ) {
        throw new Error('Invalid server plugin update lock.');
    }
    return lock;
}

export function acquireServerPluginUpdateMutex(updatesRoot) {
    return lockfile.lockSync(updatesRoot, {
        lockfilePath: path.join(updatesRoot, SERVER_PLUGIN_UPDATE_MUTEX),
        realpath: false,
        stale: UPDATE_MUTEX_STALE_MS,
        update: UPDATE_MUTEX_STALE_MS / 3,
        retries: 0,
    });
}

export function validateServerPluginUpdateLock(lockPath, transactionId) {
    const lock = readUpdateLock(lockPath);
    if (lock.transactionId !== transactionId) {
        throw new Error('Server plugin update lock belongs to another transaction.');
    }
    return lock;
}

function acquireUpdateLock(updatesRoot, transactionId, ownerPid) {
    const lockPath = path.join(updatesRoot, UPDATE_LOCK_NAME);
    let releaseMutex;
    try {
        releaseMutex = acquireServerPluginUpdateMutex(updatesRoot);
    } catch (error) {
        if (error?.code === 'ELOCKED') {
            fail(409, 'update_busy', 'Another server plugin update is already in progress.');
        }
        throw error;
    }
    try {
        if (fs.existsSync(lockPath)) {
            fail(409, 'update_busy', 'Another server plugin update is already in progress. Restart SillyBunny to recover an abandoned transaction.');
        }
        writeDurableFile(lockPath, JSON.stringify({
            schemaVersion: 1,
            transactionId,
            pid: ownerPid,
            createdAt: new Date().toISOString(),
        }), { flag: 'wx', mode: 0o600 });
        return lockPath;
    } finally {
        releaseMutex();
    }
}

export function releaseServerPluginUpdateLock(lockPath, transactionId) {
    if (!lockPath || !fs.existsSync(lockPath)) {
        return;
    }
    validateServerPluginUpdateLock(lockPath, transactionId);
    fs.rmSync(lockPath);
    syncServerPluginDirectory(path.dirname(lockPath));
}

function assertRealPluginDirectory(pluginsRoot, directoryName) {
    if (!DIRECTORY_NAME_PATTERN.test(directoryName) || directoryName.startsWith('.')) {
        fail(400, 'invalid_directory', 'Server plugin directoryName is invalid.');
    }

    const rootPath = path.resolve(pluginsRoot);
    const pluginPath = path.resolve(rootPath, directoryName);

    if (path.dirname(pluginPath) !== rootPath) {
        fail(400, 'invalid_directory', 'Server plugin directoryName must identify one direct child of the plugins directory.');
    }

    let pluginStat;
    try {
        pluginStat = fs.lstatSync(pluginPath);
    } catch {
        fail(404, 'plugin_missing', `Server plugin ${directoryName} is not installed.`);
    }

    if (!pluginStat.isDirectory() || pluginStat.isSymbolicLink()) {
        fail(409, 'managed_externally', 'Symlinked or externally managed server plugins cannot be updated automatically.');
    }

    const realRoot = fs.realpathSync(rootPath);
    const realPlugin = fs.realpathSync(pluginPath);
    if (!isPathInside(realRoot, realPlugin) || path.dirname(realPlugin) !== realRoot) {
        fail(409, 'managed_externally', 'The server plugin resolves outside the managed plugins directory.');
    }

    return { pluginsRoot: realRoot, pluginPath: realPlugin };
}

export function validateServerPluginPreservePaths(packageJson) {
    const values = packageJson?.sillybunny?.serverPlugin?.preservePaths ?? [];

    if (!Array.isArray(values) || values.length > MAX_PRESERVE_PATHS) {
        fail(422, 'invalid_preserve_paths', `preservePaths must be an array with at most ${MAX_PRESERVE_PATHS} entries.`);
    }

    const normalizedPaths = values.map(value => {
        const raw = String(value ?? '').trim().replaceAll('\\', '/');
        const parts = raw.split('/');

        if (
            !raw
            || raw.includes('\0')
            || raw.startsWith('/')
            || /^[A-Za-z]:/.test(raw)
            || parts.some(part => !part || part === '.' || part === '..')
            || BLOCKED_PRESERVE_ROOTS.has(parts[0].toLowerCase())
        ) {
            fail(422, 'invalid_preserve_paths', `Unsafe server plugin preserve path: ${raw || '(empty)'}.`);
        }

        return parts.join(path.sep);
    });

    const portablePaths = normalizedPaths.map(value => value.split(path.sep).join('/').toLowerCase());
    for (let index = 0; index < portablePaths.length; index++) {
        if (portablePaths.some((other, otherIndex) => (
            otherIndex !== index
            && (other === portablePaths[index]
                || other.startsWith(`${portablePaths[index]}/`)
                || portablePaths[index].startsWith(`${other}/`))
        ))) {
            fail(422, 'invalid_preserve_paths', `Overlapping server plugin preserve path: ${normalizedPaths[index]}.`);
        }
    }

    return normalizedPaths;
}

function assertSafeReleaseTree(directoryPath, releaseRoot = directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        if (directoryPath === releaseRoot && entry.name === '.git') {
            continue;
        }

        const entryPath = path.join(directoryPath, entry.name);
        const stat = fs.lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
            fail(422, 'unsafe_release', `Server plugin releases cannot contain symbolic links: ${path.relative(releaseRoot, entryPath)}.`);
        }
        if (stat.isDirectory()) {
            assertSafeReleaseTree(entryPath, releaseRoot);
        }
    }
}

export function getServerPluginReleaseDigest(releaseRoot, { excludePaths = [] } = {}) {
    const root = fs.realpathSync(releaseRoot);
    const excluded = new Set(excludePaths.map(value => String(value).split(path.sep).join('/')));
    const hash = createHash('sha256');

    const isExcluded = relativePath => [...excluded].some(value => relativePath === value || relativePath.startsWith(`${value}/`));
    const walk = directoryPath => {
        const entries = fs.readdirSync(directoryPath).sort((left, right) => left.localeCompare(right));
        for (const name of entries) {
            const entryPath = path.join(directoryPath, name);
            const relativePath = path.relative(root, entryPath).split(path.sep).join('/');
            if (relativePath === '.git' || relativePath.startsWith('.git/') || isExcluded(relativePath)) {
                continue;
            }

            const stat = fs.lstatSync(entryPath);
            if (stat.isSymbolicLink()) {
                const linkTarget = fs.readlinkSync(entryPath);
                const realTarget = fs.realpathSync(entryPath);
                if (path.isAbsolute(linkTarget) || !relativePath.startsWith('node_modules/') || !isPathInside(root, realTarget)) {
                    fail(422, 'unsafe_release', `Server plugin release contains an unsafe symbolic link: ${relativePath}.`);
                }
                hash.update(`L\0${relativePath}\0${linkTarget}\0`);
            } else if (stat.isDirectory()) {
                walk(entryPath);
            } else if (stat.isFile()) {
                hash.update(`F\0${relativePath}\0${stat.mode & 0o777}\0${stat.size}\0`);
                hash.update(fs.readFileSync(entryPath));
                hash.update('\0');
            } else {
                fail(422, 'unsafe_release', `Server plugin release contains an unsupported file type: ${relativePath}.`);
            }
        }
    };

    walk(root);
    return hash.digest('hex');
}

function createUpdateJournal(journalPath, stagedUpdate) {
    writeDurableFile(journalPath, `${JSON.stringify({
        schemaVersion: 1,
        state: 'staged',
        recordedAt: new Date().toISOString(),
        ...stagedUpdate,
    })}\n`, { flag: 'wx', mode: 0o600 });
}

function assertManagedDirectory(parentPath, directoryName) {
    const parentStat = fs.lstatSync(parentPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        fail(409, 'managed_externally', 'The server plugins directory must be a regular directory.');
    }

    const realParent = fs.realpathSync(parentPath);
    const directoryPath = path.join(realParent, directoryName);
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { mode: 0o700 });
    }

    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directoryPath) !== directoryPath) {
        fail(409, 'managed_externally', `${directoryName} must be a regular directory inside the server plugins directory.`);
    }

    return { pluginsRoot: realParent, directoryPath };
}

async function inspectInstalledPlugin(pluginPath, runCommand, options) {
    const packageJson = readPackageJson(path.join(pluginPath, 'package.json'), 'Installed server plugin');
    const repository = normalizeRepositoryUrl(getRepositoryValue(packageJson), options);

    if (!repository) {
        fail(422, 'invalid_repository', 'Installed server plugin package.json must declare a supported repository URL.');
    }

    const repositoryCheck = await runCommand('git', ['-C', pluginPath, 'rev-parse', '--show-toplevel'], { cwd: pluginPath });
    if (path.resolve(repositoryCheck.stdout) !== pluginPath) {
        fail(409, 'managed_externally', 'Installed server plugin is not the root of its Git checkout.');
    }

    const status = await runCommand('git', ['-C', pluginPath, 'status', '--porcelain', '--untracked-files=no'], { cwd: pluginPath });
    if (status.stdout.trim()) {
        fail(409, 'dirty_checkout', 'Server plugin has tracked local changes. Commit or discard them before updating.');
    }

    const originResult = await runCommand('git', ['-C', pluginPath, 'remote', 'get-url', 'origin'], { cwd: pluginPath });
    const originUrl = originResult.stdout.trim();
    if (normalizeRepositoryUrl(originUrl, options) !== repository) {
        fail(409, 'wrong_remote', 'Server plugin origin does not match the repository declared by package.json.');
    }

    const headResult = await runCommand('git', ['-C', pluginPath, 'rev-parse', 'HEAD'], { cwd: pluginPath });
    const commit = headResult.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
        fail(409, 'invalid_checkout', 'Installed server plugin HEAD is not a full Git commit.');
    }

    return { packageJson, repository, originUrl, commit };
}

async function isInstalledExactRelease(pluginPath, installed, version, runCommand) {
    const markerPath = path.join(pluginPath, SERVER_PLUGIN_RELEASE_MARKER);

    try {
        const markerStat = fs.lstatSync(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
            return false;
        }

        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (
            marker.schemaVersion !== 1
            || marker.packageName !== installed.packageJson.name
            || marker.repository !== installed.repository
            || marker.version !== version
            || marker.tag !== `v${version}`
            || marker.commit !== installed.commit
        ) {
            return false;
        }

        const tagResult = await runCommand('git', ['-C', pluginPath, 'rev-parse', `refs/tags/v${version}^{commit}`], { cwd: pluginPath });
        return tagResult.stdout.trim() === installed.commit;
    } catch {
        return false;
    }
}

function validateTargetPackage(installed, targetPackage, targetVersion, releaseRoot, options) {
    const targetRepository = normalizeRepositoryUrl(getRepositoryValue(targetPackage), options);
    if (String(targetPackage?.name ?? '') !== String(installed.packageJson?.name ?? '')) {
        fail(422, 'package_mismatch', 'Release package name does not match the installed server plugin.');
    }
    if (targetRepository !== installed.repository) {
        fail(422, 'repository_mismatch', 'Release repository does not match the installed server plugin.');
    }
    if (String(targetPackage?.version ?? '') !== targetVersion) {
        fail(422, 'version_mismatch', `Release package version is not ${targetVersion}.`);
    }
    const main = String(targetPackage?.main ?? '').trim().replaceAll('\\', '/');
    const mainPath = path.resolve(releaseRoot, main);
    const mainStat = main && !main.includes('\0') && isPathInside(releaseRoot, mainPath)
        ? fs.lstatSync(mainPath, { throwIfNoEntry: false })
        : null;
    if (!mainStat?.isFile() || mainStat.isSymbolicLink()) {
        fail(422, 'invalid_package', 'Release package.json must declare a regular server plugin entry point inside the release.');
    }

    const pluginId = String(targetPackage?.sillybunny?.serverPlugin?.id ?? '').trim();
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
        fail(422, 'invalid_package', 'Release package.json must declare a valid sillybunny.serverPlugin.id.');
    }

    const lockPath = path.join(releaseRoot, 'package-lock.json');
    const lockStat = fs.existsSync(lockPath) ? fs.lstatSync(lockPath) : null;
    if (!lockStat?.isFile() || lockStat.isSymbolicLink()) {
        fail(422, 'lockfile_required', 'Release must include a regular package-lock.json for deterministic dependency installation.');
    }

    return pluginId;
}

export function getServerPluginUpdateCapabilities({
    commandExists = commandExistsSync,
    supervised = isServerPluginUpdateSupervised(),
} = {}) {
    const gitAvailable = commandExists('git');
    const npmAvailable = commandExists('npm');

    return {
        apiVersion: SERVER_PLUGIN_UPDATE_API_VERSION,
        exactGitRelease: true,
        existingPluginsOnly: true,
        installsDependencies: true,
        dependencyPolicy: 'npm-ci-production-ignore-scripts',
        safeRestart: supervised,
        tooling: {
            git: gitAvailable,
            npm: npmAvailable,
        },
        available: gitAvailable && npmAvailable && supervised,
    };
}

export async function stageServerPluginRelease({
    pluginsRoot,
    directoryName,
    targetVersion,
}, {
    commandExists = commandExistsSync,
    runCommand = runServerPluginCommand,
    allowFileRepositories = false,
    platform = process.platform,
    lockOwnerPid = process.env.SILLYBUNNY_SUPERVISED === '1' ? process.ppid : process.pid,
} = {}) {
    const version = String(targetVersion ?? '').trim();
    const pluginDirectoryName = String(directoryName ?? '').trim();
    if (!parseVersion(version)) {
        fail(400, 'invalid_version', 'targetVersion must be a stable X.Y.Z release version.');
    }

    // The route verifies supervisor support before staging. This function only
    // needs to verify the tools required to build the release transaction.
    const capabilities = getServerPluginUpdateCapabilities({ commandExists, supervised: true });
    if (!capabilities.available) {
        fail(503, 'tooling_unavailable', 'Git and npm are required for automatic server plugin updates.');
    }

    const resolvedRoot = path.resolve(pluginsRoot);
    const managedPaths = assertManagedDirectory(resolvedRoot, SERVER_PLUGIN_UPDATE_DIRECTORY);
    const updatesRoot = managedPaths.directoryPath;
    const transactionId = randomUUID();
    const lockPath = acquireUpdateLock(updatesRoot, transactionId, lockOwnerPid);
    const journalPath = path.join(updatesRoot, `${transactionId}${JOURNAL_SUFFIX}`);
    let stagingRoot = null;

    try {
        const paths = assertRealPluginDirectory(managedPaths.pluginsRoot, pluginDirectoryName);
        const installed = await inspectInstalledPlugin(paths.pluginPath, runCommand, { allowFileRepositories });
        const currentVersion = String(installed.packageJson?.version ?? '').trim();
        const comparison = compareServerPluginVersions(version, currentVersion);

        if (comparison === null) {
            fail(422, 'invalid_installed_version', 'Installed server plugin does not use a stable X.Y.Z version.');
        }
        if (comparison < 0) {
            fail(409, 'downgrade_blocked', `Refusing to downgrade server plugin from ${currentVersion} to ${version}.`);
        }
        if (comparison === 0 && await isInstalledExactRelease(paths.pluginPath, installed, version, runCommand)) {
            releaseServerPluginUpdateLock(lockPath, transactionId);
            return {
                action: 'unchanged',
                currentVersion,
                targetVersion: version,
                restarting: false,
            };
        }

        const tag = `v${version}`;
        stagingRoot = fs.mkdtempSync(path.join(updatesRoot, `${pluginDirectoryName}-`));
        syncServerPluginDirectory(updatesRoot);
        const releaseRoot = path.join(stagingRoot, 'release');

        await runCommand('git', [
            'clone',
            '--depth', '1',
            '--branch', tag,
            '--single-branch',
            '--', installed.originUrl, releaseRoot,
        ], { cwd: updatesRoot });

        assertSafeReleaseTree(releaseRoot);
        if (fs.existsSync(path.join(releaseRoot, SERVER_PLUGIN_RELEASE_MARKER))) {
            fail(422, 'unsafe_release', `Release must not contain ${SERVER_PLUGIN_RELEASE_MARKER}.`);
        }

        const targetPackage = readPackageJson(path.join(releaseRoot, 'package.json'), 'Server plugin release');
        const expectedPluginId = validateTargetPackage(installed, targetPackage, version, releaseRoot, { allowFileRepositories });

        const headResult = await runCommand('git', ['-C', releaseRoot, 'rev-parse', 'HEAD'], { cwd: releaseRoot });
        const tagResult = await runCommand('git', ['-C', releaseRoot, 'rev-parse', `refs/tags/${tag}^{commit}`], { cwd: releaseRoot });
        const commit = headResult.stdout.trim();
        if (!/^[0-9a-f]{40}$/i.test(commit) || commit !== tagResult.stdout.trim()) {
            fail(422, 'tag_mismatch', `Release tag ${tag} did not resolve to the checked-out commit.`);
        }

        const targetOrigin = await runCommand('git', ['-C', releaseRoot, 'remote', 'get-url', 'origin'], { cwd: releaseRoot });
        if (normalizeRepositoryUrl(targetOrigin.stdout, { allowFileRepositories }) !== installed.repository) {
            fail(422, 'repository_mismatch', 'Cloned release origin does not match the installed server plugin.');
        }

        const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
        await runCommand(npmCommand, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: releaseRoot });

        const preservePaths = validateServerPluginPreservePaths(targetPackage);
        for (const relativePath of preservePaths) {
            if (fs.lstatSync(path.join(releaseRoot, relativePath), { throwIfNoEntry: false })) {
                fail(422, 'preserve_path_conflict', `Release already contains preserved path ${relativePath}.`);
            }
        }

        const marker = {
            schemaVersion: 1,
            packageName: targetPackage.name,
            repository: installed.repository,
            version,
            tag,
            commit,
            managedAt: new Date().toISOString(),
        };
        writeDurableFile(path.join(releaseRoot, SERVER_PLUGIN_RELEASE_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

        const releaseDigest = getServerPluginReleaseDigest(releaseRoot, { excludePaths: preservePaths });
        const stagedUpdate = {
            transactionId,
            pluginsRoot: paths.pluginsRoot,
            directoryName: pluginDirectoryName,
            pluginPath: paths.pluginPath,
            stagingRoot,
            releaseRoot,
            lockPath,
            journalPath,
            targetVersion: version,
            tag,
            commit,
            preservePaths,
            expectedPluginId,
            releaseDigest,
        };
        syncServerPluginTree(releaseRoot);
        syncServerPluginDirectory(stagingRoot);
        createUpdateJournal(journalPath, stagedUpdate);

        return {
            ...stagedUpdate,
            action: 'updated',
            currentVersion,
            restarting: true,
        };
    } catch (error) {
        if (error?.serverPluginCommandTerminationUnconfirmed) {
            error.preserveServerPluginTransaction = true;
            throw error;
        }
        if (stagingRoot) {
            fs.rmSync(stagingRoot, { recursive: true, force: true });
            syncServerPluginDirectory(updatesRoot);
        }
        fs.rmSync(journalPath, { force: true });
        syncServerPluginDirectory(updatesRoot);
        releaseServerPluginUpdateLock(lockPath, transactionId);
        throw error;
    }
}

export function discardStagedServerPluginRelease(stagedUpdate) {
    if (stagedUpdate?.stagingRoot) {
        fs.rmSync(stagedUpdate.stagingRoot, { recursive: true, force: true });
        syncServerPluginDirectory(path.dirname(stagedUpdate.stagingRoot));
    }
    releaseServerPluginUpdateLock(stagedUpdate?.lockPath, stagedUpdate?.transactionId);
    if (stagedUpdate?.journalPath) {
        fs.rmSync(stagedUpdate.journalPath, { force: true });
        syncServerPluginDirectory(path.dirname(stagedUpdate.journalPath));
    }
}
