const ORIGIN_REMOTE_PREFIX = 'origin/';
const RUNTIME_BRANCH_PREFIX = 'runtime/';
const BUN_LOCK_FILE = 'bun.lock';

export const NON_GIT_REPOSITORY_MESSAGE = 'This install is not running from a Git repository. Built-in updates require a Git checkout; release ZIP installs need to download and extract the latest release.';

function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export async function isGitRepository(git) {
    return Boolean(await git.checkIsRepo().catch(() => false));
}

export function getRemoteBranchDisplayName(remoteBranch) {
    const branch = String(remoteBranch ?? '').trim();

    if (branch.startsWith(ORIGIN_REMOTE_PREFIX)) {
        return branch.slice(ORIGIN_REMOTE_PREFIX.length);
    }

    return branch;
}

export function isRuntimeBranch(branch) {
    return String(branch ?? '').trim().startsWith(RUNTIME_BRANCH_PREFIX);
}

export function getStatusDisplayBranch(branch, trackingBranch) {
    const currentBranch = String(branch ?? '').trim();
    const upstreamBranch = String(trackingBranch ?? '').trim();

    if ((!currentBranch || currentBranch === 'HEAD' || currentBranch.startsWith(RUNTIME_BRANCH_PREFIX)) && upstreamBranch) {
        return getRemoteBranchDisplayName(upstreamBranch);
    }

    return currentBranch;
}

export function getRemoteBranchesFromSummary(branchSummary) {
    const branches = branchSummary?.branches ?? {};

    return uniqueSorted(Object.keys(branches)
        .map(branch => String(branch ?? '').trim())
        .filter(branch => branch && !branch.endsWith('/HEAD') && !branch.includes('/HEAD -> ')));
}

export function hasOnlyBunLockChange(files) {
    const changedPaths = (Array.isArray(files) ? files : [])
        .map(file => String(file?.path ?? file ?? '').trim().replaceAll('\\', '/'))
        .filter(Boolean);

    return changedPaths.length === 1 && changedPaths[0] === BUN_LOCK_FILE;
}

export function getBranchDisplayNames(remoteBranches) {
    return uniqueSorted(remoteBranches
        .map(getRemoteBranchDisplayName)
        .filter(Boolean));
}

export function resolveRemoteBranchName(remoteBranches, branch) {
    const requestedBranch = String(branch ?? '').trim();

    if (!requestedBranch) {
        return '';
    }

    if (remoteBranches.includes(requestedBranch)) {
        return requestedBranch;
    }

    const originBranch = `${ORIGIN_REMOTE_PREFIX}${requestedBranch}`;
    if (remoteBranches.includes(originBranch)) {
        return originBranch;
    }

    const matchingBranches = remoteBranches.filter(remoteBranch => getRemoteBranchDisplayName(remoteBranch) === requestedBranch);

    return matchingBranches.length === 1 ? matchingBranches[0] : '';
}
