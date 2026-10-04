const ORIGIN_REMOTE_PREFIX = 'origin/';
const RUNTIME_BRANCH_PREFIX = 'runtime/';
const GENERATED_INSTALL_FILES = Object.freeze(['bun.lock', 'package-lock.json', 'package.json']);

export const NON_GIT_REPOSITORY_MESSAGE = 'This install is not running from a Git repository. Use Customize > Server to check for a release ZIP update, or install with git clone for Git updates.';

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

export function getGeneratedInstallChangePaths(files) {
    const fileEntries = Array.isArray(files) ? files : [];
    const changedEntries = fileEntries
        .map(file => ({
            path: String(file?.path ?? file ?? '').trim().replaceAll('\\', '/'),
            isUntracked: file?.index === '?' || file?.working_dir === '?',
        }))
        .filter(file => file.path);

    if (!changedEntries.length || changedEntries.some(file => file.isUntracked || !GENERATED_INSTALL_FILES.includes(file.path))) {
        return [];
    }

    return uniqueSorted(changedEntries.map(file => file.path));
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
