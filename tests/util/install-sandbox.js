import { jest } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectoryModule = fileURLToPath(new URL('../../src/server-directory.js', import.meta.url));

/**
 * Registers a module mock for the server directory.
 * Call it before the first import under src/, because those modules read the directory when they load.
 */
export function createInstallSandbox(prefix) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `${prefix}-`));
    const installDir = path.join(root, 'install');
    const dataRoot = path.join(root, 'data');
    const configPath = path.join(root, 'config.yaml');

    fs.mkdirSync(installDir);
    fs.mkdirSync(dataRoot);
    fs.writeFileSync(configPath, '{}\n');
    jest.unstable_mockModule(serverDirectoryModule, () => ({ serverDirectory: installDir }));

    return {
        root,
        installDir,
        dataRoot,
        configPath,
        clear() {
            emptyDirectory(installDir);
            emptyDirectory(dataRoot);
        },
        dispose() {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
        },
    };
}

/**
 * Throws when the mock from createInstallSandbox() does not reach src/server-directory.js.
 * Call it before code that moves, rewrites or deletes files, because without the mock those paths point at the real install folder.
 */
export async function assertSandboxedInstall(sandbox) {
    const { serverDirectory } = await import('../../src/server-directory.js');
    if (serverDirectory !== sandbox.installDir) {
        sandbox.dispose();
        throw new Error('The install sandbox does not replace serverDirectory, so the migrations would change the real install folder.');
    }
}

/** Keeps the directory itself, because it can be the working directory and Windows cannot remove that. */
export function emptyDirectory(directory) {
    for (const entry of fs.readdirSync(directory)) {
        fs.rmSync(path.join(directory, entry), { recursive: true, force: true, maxRetries: 5 });
    }
}

export function writeFiles(baseDir, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(baseDir, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

/** Maps each path below the directory to 'dir' or to the SHA-256 of the file bytes. Paths use forward slashes on every platform. */
export function snapshotTree(directory) {
    const entries = {};

    const visit = (current) => {
        for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, dirent.name);
            const key = path.relative(directory, entryPath).split(path.sep).join('/');
            if (dirent.isDirectory()) {
                entries[key] = 'dir';
                visit(entryPath);
            } else {
                entries[key] = crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
            }
        }
    };

    visit(directory);
    return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
