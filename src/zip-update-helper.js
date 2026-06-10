import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PROTECTED_TOP_LEVEL = new Set(['.git', 'backups', 'cache', 'data', 'node_modules']);

function decodePayload(encoded) {
    const decoded = Buffer.from(String(encoded ?? ''), 'base64').toString('utf8');
    return JSON.parse(decoded);
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== 'ESRCH';
    }
}

function isPathInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function buildVisibleWindowsCommand(command, cwd) {
    const quoted = command.map(value => `"${String(value).replace(/"/g, '\\"')}"`).join(' ');
    const title = 'SillyBunny Server';
    return [
        'cmd.exe',
        [
            '/d',
            '/s',
            '/c',
            'start',
            `"${title}"`,
            '/D',
            `"${cwd}"`,
            'cmd.exe',
            '/k',
            quoted,
        ],
    ];
}

async function waitForParentExit(pid) {
    while (isProcessAlive(pid)) {
        await delay(250);
    }
}

function createTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function appendLog(logPath, message) {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function shouldSkipRelativePath(relativePath) {
    const topLevel = String(relativePath ?? '').split(path.sep)[0];
    return PROTECTED_TOP_LEVEL.has(topLevel);
}

function collectReleaseEntries(releaseRoot, currentDirectory = releaseRoot, entries = []) {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
        const sourcePath = path.join(currentDirectory, entry.name);
        const relativePath = path.relative(releaseRoot, sourcePath);

        if (shouldSkipRelativePath(relativePath)) {
            continue;
        }

        if (entry.isDirectory()) {
            entries.push({ type: 'directory', sourcePath, relativePath, mode: fs.statSync(sourcePath).mode & 0o777 });
            collectReleaseEntries(releaseRoot, sourcePath, entries);
        } else if (entry.isFile()) {
            entries.push({ type: 'file', sourcePath, relativePath, mode: fs.statSync(sourcePath).mode & 0o777 });
        }
    }

    return entries;
}

function backupDestination(destinationPath, backupRoot, installDir, state) {
    if (!fs.existsSync(destinationPath) || state.backups.has(destinationPath)) {
        return;
    }

    const backupPath = path.join(backupRoot, path.relative(installDir, destinationPath));
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.cpSync(destinationPath, backupPath, { recursive: true, force: true, verbatimSymlinks: true });
    state.backups.set(destinationPath, backupPath);
}

function removePath(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyFileWithMode(sourcePath, destinationPath, mode) {
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, mode || 0o644);
}

function applyReleaseOverlay({ releaseRoot, installDir, backupRoot, logPath }, state) {
    const entries = collectReleaseEntries(releaseRoot);

    appendLog(logPath, `Applying ${entries.length} release entries from ${releaseRoot}.`);

    for (const entry of entries) {
        const destinationPath = path.resolve(installDir, entry.relativePath);

        if (!isPathInside(installDir, destinationPath)) {
            throw new Error(`Release entry escapes the install directory: ${entry.relativePath}`);
        }

        if (entry.type === 'directory') {
            if (fs.existsSync(destinationPath) && !fs.statSync(destinationPath).isDirectory()) {
                backupDestination(destinationPath, backupRoot, installDir, state);
                removePath(destinationPath);
            }

            if (!fs.existsSync(destinationPath)) {
                fs.mkdirSync(destinationPath, { recursive: true, mode: entry.mode || 0o755 });
                state.createdPaths.push(destinationPath);
            }
            continue;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

        if (fs.existsSync(destinationPath)) {
            backupDestination(destinationPath, backupRoot, installDir, state);
            if (fs.statSync(destinationPath).isDirectory()) {
                removePath(destinationPath);
            }
        } else {
            state.createdPaths.push(destinationPath);
        }

        copyFileWithMode(entry.sourcePath, destinationPath, entry.mode);
    }
}

function rollbackOverlay(installDir, state, logPath) {
    appendLog(logPath, 'Rolling back ZIP update overlay.');

    for (const createdPath of [...state.createdPaths].sort((left, right) => right.length - left.length)) {
        removePath(createdPath);
    }

    const backups = [...state.backups.entries()].sort(([left], [right]) => right.length - left.length);
    for (const [destinationPath, backupPath] of backups) {
        if (!isPathInside(installDir, destinationPath)) {
            continue;
        }
        removePath(destinationPath);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.cpSync(backupPath, destinationPath, { recursive: true, force: true, verbatimSymlinks: true });
    }
}

function hasCommand(command) {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
    return result.status === 0;
}

function runInstallCommand(installDir, logPath) {
    const hasDevDependencies = fs.existsSync(path.join(installDir, 'node_modules', 'eslint', 'package.json'));
    let command = '';
    let args = [];

    if (fs.existsSync(path.join(installDir, 'bun.lock')) && hasCommand('bun')) {
        command = 'bun';
        args = hasDevDependencies ? ['install'] : ['install', '--production'];
    } else if (fs.existsSync(path.join(installDir, 'package-lock.json')) && hasCommand('npm')) {
        command = 'npm';
        args = hasDevDependencies
            ? ['ci', '--no-audit', '--no-fund']
            : ['ci', '--no-audit', '--no-fund', '--omit=dev'];
    } else if (fs.existsSync(path.join(installDir, 'package.json')) && hasCommand('npm')) {
        command = 'npm';
        args = hasDevDependencies
            ? ['install', '--no-audit', '--no-fund']
            : ['install', '--no-audit', '--no-fund', '--omit=dev'];
    }

    if (!command) {
        appendLog(logPath, 'Dependency install skipped because Bun/npm was unavailable.');
        return;
    }

    appendLog(logPath, `Running dependency install: ${[command, ...args].join(' ')}`);
    const result = spawnSync(command, args, {
        cwd: installDir,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: false,
    });

    if (result.stdout) {
        appendLog(logPath, result.stdout.trimEnd());
    }
    if (result.stderr) {
        appendLog(logPath, result.stderr.trimEnd());
    }

    if (result.status !== 0) {
        throw new Error(`Dependency install failed with exit code ${result.status}.`);
    }
}

function relaunchServer(payload) {
    const command = Array.isArray(payload?.command) ? payload.command : [];
    const cwd = String(payload?.installDir ?? process.cwd());
    const envPatch = payload?.envPatch && typeof payload.envPatch === 'object' ? payload.envPatch : {};
    const visibleRelaunch = Boolean(payload?.visibleRelaunch);

    if (command.length < 2) {
        return;
    }

    const relaunch = visibleRelaunch && process.platform === 'win32'
        ? buildVisibleWindowsCommand(command, cwd)
        : [command[0], command.slice(1)];

    const child = spawn(relaunch[0], relaunch[1], {
        cwd,
        detached: true,
        stdio: visibleRelaunch && process.platform === 'win32' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
        env: { ...process.env, ...envPatch },
        windowsHide: false,
    });

    child.unref();
}

function validatePayload(payload) {
    const parentPid = Number(payload?.parentPid);
    const installDir = path.resolve(String(payload?.installDir ?? ''));
    const stagingRoot = path.resolve(String(payload?.stagingRoot ?? ''));
    const releaseRoot = path.resolve(String(payload?.releaseRoot ?? ''));

    if (!Number.isFinite(parentPid) || parentPid <= 0) {
        throw new Error('ZIP update helper payload did not include a valid parent process ID.');
    }

    if (!fs.existsSync(path.join(installDir, 'package.json'))) {
        throw new Error('ZIP update helper install directory is not a SillyBunny app folder.');
    }

    if (!isPathInside(stagingRoot, releaseRoot) || !fs.existsSync(path.join(releaseRoot, 'package.json'))) {
        throw new Error('ZIP update helper release staging directory is invalid.');
    }

    return { parentPid, installDir, stagingRoot, releaseRoot };
}

async function main() {
    const payload = decodePayload(process.argv[2]);
    const { parentPid, installDir, stagingRoot, releaseRoot } = validatePayload(payload);
    const backupRoot = path.join(installDir, 'backups', `zip-update-${createTimestamp()}`);
    const logPath = path.join(backupRoot, 'zip-update.log');
    const state = { backups: new Map(), createdPaths: [] };
    let failure = null;

    fs.mkdirSync(backupRoot, { recursive: true });
    appendLog(logPath, `Waiting for parent process ${parentPid} to exit before applying ZIP update.`);
    await waitForParentExit(parentPid);
    await delay(800);

    try {
        applyReleaseOverlay({ releaseRoot, installDir, backupRoot, logPath }, state);
        runInstallCommand(installDir, logPath);
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        appendLog(logPath, 'ZIP update applied successfully. Relaunching SillyBunny.');
    } catch (error) {
        failure = error;
        appendLog(logPath, `ZIP update failed: ${error?.message || error}`);
        try {
            rollbackOverlay(installDir, state, logPath);
        } catch (rollbackError) {
            appendLog(logPath, `Rollback failed: ${rollbackError?.message || rollbackError}`);
        }
    } finally {
        relaunchServer(payload);
    }

    if (failure) {
        throw failure;
    }
}

try {
    await main();
    process.exit(0);
} catch (error) {
    console.error('ZIP update helper failed.', error);
    process.exit(1);
}
