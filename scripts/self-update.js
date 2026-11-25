#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA_HEX_PATTERN = /^[0-9a-f]{40,64}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

function isExecutableFile(candidatePath, isWindows) {
    try {
        const stat = fs.statSync(candidatePath);
        if (!stat.isFile()) {
            return false;
        }
        if (!isWindows) {
            fs.accessSync(candidatePath, fs.constants.X_OK);
        }
        return true;
    } catch {
        return false;
    }
}

function hasGitOnPath(env = process.env, platform = process.platform) {
    let rawPath = env.PATH || env.Path || '';
    if (!rawPath && platform === 'win32') {
        const entry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path');
        rawPath = entry ? String(entry[1] || '') : '';
    }
    if (!rawPath) {
        return false;
    }

    const isWindows = platform === 'win32';
    const delimiter = isWindows ? ';' : ':';
    const extensions = isWindows
        ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];

    for (const rawEntry of rawPath.split(delimiter)) {
        const dir = rawEntry.trim().replace(/^"|"$/g, '');
        if (!dir) {
            continue;
        }
        if (isWindows && isExecutableFile(path.join(dir, 'git.exe'), true)) {
            return true;
        }
        for (const ext of extensions) {
            const name = isWindows ? `git${ext.toLowerCase()}` : 'git';
            if (isExecutableFile(path.join(dir, name), isWindows)) {
                return true;
            }
        }
    }

    return false;
}

function resolveGitDirs(repoDir, env) {
    if (env.GIT_DIR || env.GIT_WORK_TREE) {
        return null;
    }

    const dotGitPath = path.join(repoDir, '.git');
    let gitDir = '';

    try {
        const stat = fs.statSync(dotGitPath);
        if (stat.isDirectory()) {
            gitDir = dotGitPath;
        } else if (stat.isFile()) {
            const firstLine = fs.readFileSync(dotGitPath, 'utf8').split(/\r?\n/, 1)[0].trim();
            if (firstLine.toLowerCase().startsWith('gitdir:')) {
                const rawTarget = firstLine.slice('gitdir:'.length).trim();
                if (rawTarget) {
                    gitDir = path.resolve(repoDir, rawTarget);
                }
            }
        }
    } catch {
        return null;
    }

    if (!gitDir) {
        return null;
    }

    let commonDir = gitDir;
    try {
        const commonRel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (commonRel) {
            commonDir = path.resolve(gitDir, commonRel);
        }
    } catch {
        // Standalone repositories do not have a commondir file.
    }

    return { gitDir, commonDir };
}

function readLooseRefSha(baseDir, refSegments) {
    if (refSegments.some(segment => !segment || segment === '.' || segment === '..')) {
        return '';
    }

    try {
        const value = fs.readFileSync(path.join(baseDir, ...refSegments), 'utf8').trim();
        return SHA_HEX_PATTERN.test(value) ? value.toLowerCase() : '';
    } catch {
        return '';
    }
}

/**
 * Resolves the tracking ref directly from .git/config when the repository uses
 * a standard single-refspec remote without config includes; returns empty so
 * the caller falls back to `git rev-parse @{upstream}` for any other layout.
 */
function readStandardUpstreamFromConfig(commonDir, currentBranch) {
    let configText = '';
    try {
        configText = fs.readFileSync(path.join(commonDir, 'config'), 'utf8');
    } catch {
        return '';
    }

    let sectionKind = '';
    let sectionName = '';
    let branchRemote = '';
    let branchMerge = '';
    const remoteFetchSpecs = new Map();

    for (const rawLine of configText.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
            continue;
        }

        if (trimmed.startsWith('[')) {
            if (!trimmed.endsWith(']')) {
                return '';
            }
            const inner = trimmed.slice(1, -1).trim();
            const headerMatch = inner.match(/^([A-Za-z0-9-]+)(?:\s+"((?:\\.|[^"\\])*)")?$/);
            if (!headerMatch) {
                return '';
            }
            sectionKind = headerMatch[1].toLowerCase();
            sectionName = (headerMatch[2] ?? '').replace(/\\(.)/g, '$1');
            if (sectionKind === 'include' || sectionKind === 'includeif') {
                return '';
            }
            continue;
        }

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) {
            continue;
        }

        const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
        let rawValue = trimmed.slice(eqIndex + 1).trim();
        if (rawValue.includes('#') || rawValue.includes(';') || rawValue.includes('"') || rawValue.includes('\\')) {
            return '';
        }
        rawValue = rawValue.trim();

        if (sectionKind === 'branch' && sectionName === currentBranch) {
            if (key === 'remote') {
                branchRemote = rawValue;
            } else if (key === 'merge') {
                branchMerge = rawValue;
            }
        } else if (sectionKind === 'remote' && sectionName && key === 'fetch') {
            const list = remoteFetchSpecs.get(sectionName) || [];
            list.push(rawValue);
            remoteFetchSpecs.set(sectionName, list);
        }
    }

    if (!branchRemote || branchRemote === '.' || !branchMerge.startsWith('refs/heads/')) {
        return '';
    }

    const fetchSpecs = remoteFetchSpecs.get(branchRemote);
    const expectedSpec = `refs/heads/*:refs/remotes/${branchRemote}/*`;
    if (!fetchSpecs || fetchSpecs.length !== 1) {
        return '';
    }

    const normalizedSpec = fetchSpecs[0].startsWith('+') ? fetchSpecs[0].slice(1) : fetchSpecs[0];
    if (normalizedSpec !== expectedSpec) {
        return '';
    }

    const mergeBranch = branchMerge.slice('refs/heads/'.length);
    if (!mergeBranch) {
        return '';
    }

    const upstreamRef = `${branchRemote}/${mergeBranch}`;
    const looseSha = readLooseRefSha(commonDir, ['refs', 'remotes', ...upstreamRef.split('/')]);
    if (!looseSha) {
        return '';
    }

    return upstreamRef;
}

export function runSelfUpdate({
    optional = false,
    repoDir = DEFAULT_REPO_DIR,
    env = process.env,
    stdout = msg => console.log(msg),
    stderr = msg => console.error(msg),
} = {}) {
    function finishEarly(message) {
        if (optional) {
            stderr(`Skipping self-update: ${message}`);
            return 0;
        }

        stderr(`Self-update failed: ${message}`);
        return 1;
    }

    function invokeGit(args) {
        const result = spawnSync('git', args, {
            cwd: repoDir,
            env,
            encoding: 'utf8',
            windowsHide: true,
        });

        return {
            status: result.status ?? 1,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            error: result.error || null,
        };
    }

    function restoreLoneBunLockChange(statusLines) {
        if (statusLines.length !== 1) {
            return { restored: false, abortCode: null };
        }

        const statusLine = statusLines[0];
        if (statusLine.length < 4 || statusLine.slice(3) !== 'bun.lock') {
            return { restored: false, abortCode: null };
        }

        const trackedResult = invokeGit(['ls-files', '--error-unmatch', 'bun.lock']);
        if (trackedResult.status !== 0) {
            return { restored: false, abortCode: null };
        }

        stdout('Restoring tracked bun.lock before self-update...');
        const restoreResult = invokeGit(['restore', '--staged', '--worktree', '--', 'bun.lock']);
        if (restoreResult.status === 0) {
            return { restored: true, abortCode: null };
        }

        invokeGit(['reset', 'HEAD', '--', 'bun.lock']);
        const checkoutResult = invokeGit(['checkout', '--', 'bun.lock']);
        if (checkoutResult.status !== 0) {
            return {
                restored: false,
                abortCode: finishEarly('could not restore generated bun.lock.'),
            };
        }

        return { restored: true, abortCode: null };
    }

    const gitDirs = resolveGitDirs(repoDir, env);
    let currentBranch = '';

    if (gitDirs) {
        try {
            const headLine = fs.readFileSync(path.join(gitDirs.gitDir, 'HEAD'), 'utf8').trim();
            if (headLine.startsWith('ref: refs/heads/') && headLine !== 'ref: refs/heads/.invalid') {
                currentBranch = headLine.slice('ref: refs/heads/'.length).trim();
            } else if (SHA_HEX_PATTERN.test(headLine)) {
                if (!hasGitOnPath(env)) {
                    return finishEarly('Git is not installed.');
                }
                return finishEarly('detached HEAD checkouts cannot be updated automatically.');
            }
        } catch {
            // Fall through to git commands when HEAD cannot be read directly.
        }
    }

    if (!currentBranch) {
        const insideWorkTree = invokeGit(['rev-parse', '--is-inside-work-tree']);
        if (insideWorkTree.error?.code === 'ENOENT') {
            return finishEarly('Git is not installed.');
        }
        if (insideWorkTree.status !== 0) {
            return finishEarly('this checkout is not a Git repository.');
        }

        const branchResult = invokeGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);
        currentBranch = branchResult.stdout.split(/\r?\n/, 1)[0].trim();
        if (branchResult.status !== 0 || !currentBranch) {
            return finishEarly('detached HEAD checkouts cannot be updated automatically.');
        }
    }

    let upstreamRef = gitDirs ? readStandardUpstreamFromConfig(gitDirs.commonDir, currentBranch) : '';
    if (!upstreamRef) {
        const upstreamResult = invokeGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
        if (upstreamResult.error?.code === 'ENOENT') {
            return finishEarly('Git is not installed.');
        }
        upstreamRef = upstreamResult.stdout.split(/\r?\n/, 1)[0].trim();
        if (upstreamResult.status !== 0 || !upstreamRef) {
            return finishEarly(`branch '${currentBranch}' does not have an upstream configured.`);
        }
    }

    // Preserve leading spaces on porcelain lines so unstaged ` M bun.lock` keeps its 3-char prefix.
    const statusResult = invokeGit(['status', '--porcelain', '--untracked-files=normal']);
    if (statusResult.error?.code === 'ENOENT') {
        return finishEarly('Git is not installed.');
    }
    if (statusResult.status !== 0) {
        return finishEarly('could not read the repository status.');
    }

    const statusLines = statusResult.stdout
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(line => line.length > 0);

    if (statusLines.length > 0) {
        const { restored, abortCode } = restoreLoneBunLockChange(statusLines);
        if (abortCode !== null) {
            return abortCode;
        }
        if (!restored) {
            return finishEarly('the working tree is not clean. Commit, stash, or remove local changes first.');
        }
    }

    const upstreamRemote = upstreamRef.split('/')[0];
    if (!upstreamRemote || upstreamRemote.startsWith('-')) {
        return finishEarly(`branch '${currentBranch}' does not have a valid upstream remote.`);
    }
    stdout(`Checking for updates on ${upstreamRef}...`);

    const rawLowSpeedTime = String(env.SILLYBUNNY_GIT_LOW_SPEED_TIME || '10').trim();
    const lowSpeedTime = POSITIVE_INTEGER_PATTERN.test(rawLowSpeedTime) ? rawLowSpeedTime : '10';
    const optionalGitConfigArgs = optional
        ? [
            '-c', `remote.${upstreamRemote}.tagOpt=--no-tags`,
            '-c', 'http.lowSpeedLimit=1000',
            '-c', `http.lowSpeedTime=${lowSpeedTime}`,
        ]
        : [];
    const fetchArgs = optional
        ? [...optionalGitConfigArgs, 'fetch', '--quiet', '--no-tags', '--', upstreamRemote]
        : ['fetch', '--quiet', '--', upstreamRemote];

    const fetchResult = invokeGit(fetchArgs);
    if (fetchResult.status !== 0) {
        return finishEarly(`could not fetch from '${upstreamRemote}'.`);
    }

    if (gitDirs) {
        const localSha = readLooseRefSha(gitDirs.commonDir, ['refs', 'heads', ...currentBranch.split('/')]);
        const remoteSha = readLooseRefSha(gitDirs.commonDir, ['refs', 'remotes', ...upstreamRef.split('/')]);
        if (localSha && localSha === remoteSha) {
            stdout('SillyBunny is already up to date.');
            return 0;
        }
    }

    const countsResult = invokeGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    if (countsResult.status !== 0) {
        return finishEarly('could not compare the local branch with its upstream.');
    }

    const countsParts = countsResult.stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(countsParts[0], 10);
    const behind = Number.parseInt(countsParts[1], 10);
    if (countsParts.length < 2 || Number.isNaN(ahead) || Number.isNaN(behind)) {
        return finishEarly('received an unexpected response while comparing revisions.');
    }

    if (ahead > 0 && behind > 0) {
        return finishEarly(`branch '${currentBranch}' has diverged from '${upstreamRef}'. Resolve it manually before using self-update.`);
    }

    if (ahead > 0) {
        stdout(`Local branch '${currentBranch}' is already ahead of '${upstreamRef}'; nothing to pull.`);
        return 0;
    }

    if (behind === 0) {
        stdout('SillyBunny is already up to date.');
        return 0;
    }

    const beforeResult = invokeGit(['rev-parse', '--short', 'HEAD']);
    const beforeRev = beforeResult.stdout.split(/\r?\n/, 1)[0].trim();
    if (beforeResult.status !== 0 || !beforeRev) {
        return finishEarly('could not read the current revision.');
    }

    stdout('Updating SillyBunny...');
    const pullResult = invokeGit([...optionalGitConfigArgs, 'pull', '--ff-only']);
    if (pullResult.status !== 0) {
        return finishEarly('git pull --ff-only failed.');
    }

    const afterResult = invokeGit(['rev-parse', '--short', 'HEAD']);
    const afterRev = afterResult.stdout.split(/\r?\n/, 1)[0].trim();
    if (afterResult.status !== 0 || !afterRev) {
        return finishEarly('the repository updated, but the new revision could not be read.');
    }

    stdout(`Updated SillyBunny from ${beforeRev} to ${afterRev}.`);
    return 0;
}

export function parseSelfUpdateArgs(argv) {
    let optional = false;
    let repoDir = DEFAULT_REPO_DIR;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (/^--?optional$/i.test(arg)) {
            optional = true;
            continue;
        }
        if (arg === '--repo' && index + 1 < argv.length) {
            repoDir = path.resolve(argv[index + 1]);
            index += 1;
            continue;
        }
        if (arg.startsWith('--repo=')) {
            repoDir = path.resolve(arg.slice('--repo='.length));
        }
    }

    return { optional, repoDir };
}

function resolveCanonicalPath(targetPath) {
    const resolved = path.resolve(targetPath);
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

const scriptPath = resolveCanonicalPath(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolveCanonicalPath(process.argv[1]) : '';
if (invokedPath && (invokedPath === scriptPath || invokedPath.toLowerCase() === scriptPath.toLowerCase())) {
    process.exitCode = runSelfUpdate(parseSelfUpdateArgs(process.argv.slice(2)));
}
