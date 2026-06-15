import { describe, expect, jest, test } from '@jest/globals';

import {
    getBranchDisplayNames,
    getGeneratedInstallChangePaths,
    getRemoteBranchesFromSummary,
    getStatusDisplayBranch,
    NON_GIT_REPOSITORY_MESSAGE,
    isGitRepository,
    isRuntimeBranch,
    resolveRemoteBranchName,
} from '../src/server-admin-git.js';

describe('server admin git helpers', () => {
    test('accepts linked worktrees as Git repositories', async () => {
        const git = {
            checkIsRepo: jest.fn(async () => true),
        };

        await expect(isGitRepository(git)).resolves.toBe(true);
        expect(git.checkIsRepo).toHaveBeenCalledWith();
    });

    test('uses the tracked remote as the display branch for runtime worktrees', () => {
        expect(getStatusDisplayBranch('runtime/sillybunny-server', 'origin/staging')).toBe('staging');
        expect(getStatusDisplayBranch('feature/admin-git', 'origin/feature/admin-git')).toBe('feature/admin-git');
    });

    test('uses the tracked remote when Git cannot report a local branch name', () => {
        expect(getStatusDisplayBranch('HEAD', 'origin/staging')).toBe('staging');
        expect(getStatusDisplayBranch('', 'origin/main')).toBe('main');
        expect(getStatusDisplayBranch('HEAD', '')).toBe('HEAD');
    });

    test('lists display names from remote branch summaries', () => {
        const remoteBranches = getRemoteBranchesFromSummary({
            branches: {
                'origin/HEAD': {},
                'origin/main': {},
                'origin/staging': {},
                'fork/main': {},
            },
        });

        expect(remoteBranches).toEqual(['fork/main', 'origin/main', 'origin/staging']);
        expect(getBranchDisplayNames(remoteBranches)).toEqual(['fork/main', 'main', 'staging']);
    });

    test('resolves stable branch names to origin before other remotes', () => {
        const remoteBranches = ['fork/main', 'origin/main', 'origin/staging'];

        expect(resolveRemoteBranchName(remoteBranches, 'main')).toBe('origin/main');
        expect(resolveRemoteBranchName(remoteBranches, 'staging')).toBe('origin/staging');
        expect(resolveRemoteBranchName(remoteBranches, 'fork/main')).toBe('fork/main');
    });

    test('recognizes runtime branches', () => {
        expect(isRuntimeBranch('runtime/sillybunny-server')).toBe(true);
        expect(isRuntimeBranch('main')).toBe(false);
    });

    test('detects only generated install metadata changes', () => {
        expect(getGeneratedInstallChangePaths([{ path: 'bun.lock', index: ' ', working_dir: 'M' }])).toEqual(['bun.lock']);
        expect(getGeneratedInstallChangePaths([{ path: 'bun.lock' }, { path: 'package.json' }])).toEqual(['bun.lock', 'package.json']);
        expect(getGeneratedInstallChangePaths([{ path: 'package-lock.json' }])).toEqual(['package-lock.json']);
    });

    test('detects deleted generated install metadata changes', () => {
        expect(getGeneratedInstallChangePaths([
            { path: 'bun.lock', index: ' ', working_dir: 'D' },
            { path: 'package.json', index: ' ', working_dir: 'D' },
        ])).toEqual(['bun.lock', 'package.json']);
    });

    test('rejects generated install metadata mixed with other changes', () => {
        expect(getGeneratedInstallChangePaths([{ path: 'bun.lock' }, { path: 'public/script.js' }])).toEqual([]);
        expect(getGeneratedInstallChangePaths([
            { path: 'bun.lock', index: ' ', working_dir: 'M' },
            { path: 'public/script.js', index: '?', working_dir: '?' },
        ])).toEqual([]);
    });

    test('rejects empty and untracked generated install metadata changes', () => {
        expect(getGeneratedInstallChangePaths([])).toEqual([]);
        expect(getGeneratedInstallChangePaths([{ path: 'package-lock.json', index: '?', working_dir: '?' }])).toEqual([]);
    });

    test('explains how non-Git installs update', () => {
        expect(NON_GIT_REPOSITORY_MESSAGE).toContain('Git repository');
        expect(NON_GIT_REPOSITORY_MESSAGE).toContain('release ZIP');
    });
});
