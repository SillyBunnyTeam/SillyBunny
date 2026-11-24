import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { serverDirectory } from './server-directory.js';

export const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function readStatTuple(targetPath) {
    try {
        const stats = fs.statSync(targetPath);
        const kind = stats.isDirectory() ? 'd' : stats.isFile() ? 'f' : 'o';
        return `${kind}:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
    } catch {
        return 'absent';
    }
}

function readGitHeadSignature(rootDir) {
    const dotGitPath = path.join(rootDir, '.git');
    let gitDir = dotGitPath;
    let commonGitDir = dotGitPath;

    try {
        const dotGitStats = fs.statSync(dotGitPath);
        if (dotGitStats.isFile()) {
            // Worktrees store a `gitdir:` pointer file instead of a `.git` directory.
            const pointer = fs.readFileSync(dotGitPath, 'utf8').trim();
            if (!pointer.startsWith('gitdir:')) {
                return 'nogit';
            }
            gitDir = path.resolve(rootDir, pointer.slice('gitdir:'.length).trim());
            commonGitDir = gitDir;
            const commonDirFile = path.join(gitDir, 'commondir');
            if (fs.existsSync(commonDirFile)) {
                commonGitDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
            }
        } else if (!dotGitStats.isDirectory()) {
            return 'nogit';
        }
    } catch {
        return 'nogit';
    }

    try {
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref:')) {
            return `detached:${head}`;
        }
        const refRel = head.slice('ref:'.length).trim();
        for (const candidateBase of [gitDir, commonGitDir]) {
            const refPath = path.join(candidateBase, refRel);
            if (fs.existsSync(refPath)) {
                return `${refRel}:${fs.readFileSync(refPath, 'utf8').trim()}`;
            }
        }
        return `${refRel}:packed:${readStatTuple(path.join(commonGitDir, 'packed-refs'))}`;
    } catch {
        return 'nogit';
    }
}

function readPackageVersionSignature(rootDir) {
    const pkgPath = path.join(rootDir, 'package.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return `${String(parsed?.version ?? 'unknown')}:${readStatTuple(pkgPath)}`;
    } catch {
        return readStatTuple(pkgPath);
    }
}

function readPublicTopLevelSignature(rootDir) {
    const publicDir = path.join(rootDir, 'public');
    try {
        const entries = fs.readdirSync(publicDir, { withFileTypes: true })
            .map(entry => entry.name)
            .sort();
        return entries.map(name => `${name}=${readStatTuple(path.join(publicDir, name))}`).join(';');
    } catch {
        return 'absent';
    }
}

function readThirdPartyExtensionsSignature(rootDir) {
    const thirdPartyDir = path.join(rootDir, 'public', 'scripts', 'extensions', 'third-party');
    try {
        const entries = fs.readdirSync(thirdPartyDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() || entry.isFile())
            .map(entry => entry.name)
            .sort();
        return entries.map((name) => {
            const extPath = path.join(thirdPartyDir, name);
            const statSig = readStatTuple(extPath);
            const manifestSig = readStatTuple(path.join(extPath, 'manifest.json'));
            const gitSig = readGitHeadSignature(extPath);
            return `${name}=${statSig},${manifestSig},${gitSig}`;
        }).join(';');
    } catch {
        return 'absent';
    }
}

/**
 * Computes a deterministic fingerprint of served frontend inputs so unchanged
 * server restarts keep browser caches warm instead of triggering Clear-Site-Data reloads.
 * @param {object} [options]
 * @param {string} [options.rootDir] Server root directory
 * @returns {string}
 */
export function computeContentBootId({ rootDir = serverDirectory } = {}) {
    const hash = createHash('sha256');
    hash.update(readPackageVersionSignature(rootDir));
    hash.update('\0');
    hash.update(readGitHeadSignature(rootDir));
    hash.update('\0');
    hash.update(readPublicTopLevelSignature(rootDir));
    hash.update('\0');
    hash.update(readStatTuple(path.join(rootDir, 'dist', 'frontend', 'asset-manifest.json')));
    hash.update('\0');
    hash.update(readThirdPartyExtensionsSignature(rootDir));
    return `c-${hash.digest('hex').slice(0, 24)}`;
}

export const CONTENT_BOOT_ID = computeContentBootId();

let restartCacheGeneration = 0;

export function getServerBootId() {
    return SERVER_BOOT_ID;
}

/**
 * @param {unknown} mode Configured mode (`content` or `always`)
 * @param {NodeJS.ProcessEnv} [env] Environment variables
 * @returns {'content' | 'always'}
 */
export function resolveRestartCacheClearMode(mode, env = process.env) {
    if (env?.SB_DEV === '1') {
        return 'always';
    }
    return String(mode ?? 'content').trim().toLowerCase() === 'always' ? 'always' : 'content';
}

/**
 * Returns the boot identifier used by `restartCacheClear` cookies.
 * @param {object} [options]
 * @param {unknown} [options.mode] `content` (default) or `always`
 * @param {NodeJS.ProcessEnv} [options.env] Environment variables
 * @returns {string}
 */
export function getRestartCacheBootId({ mode, env = process.env } = {}) {
    const resolvedMode = resolveRestartCacheClearMode(mode, env);
    const baseId = resolvedMode === 'always' ? SERVER_BOOT_ID : CONTENT_BOOT_ID;
    return restartCacheGeneration > 0 ? `${baseId}-g${restartCacheGeneration}` : baseId;
}

/**
 * Advances the runtime cache-clear generation after in-process extension installs or updates.
 * @returns {string} Updated restart-cache boot identifier
 */
export function bumpRestartCacheGeneration() {
    restartCacheGeneration += 1;
    return getRestartCacheBootId();
}
