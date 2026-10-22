/* global Atomics, SharedArrayBuffer */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitEnv, FIXTURE_EPOCH, gitDate, gitResult, runGit } from './git.js';

export const SILLYBUNNY_REPO = 'SillyBunny.git';
export const EXTENSION_REPO = 'sillybunny-smoke-extension.git';
export const PLUGIN_REPO = 'sillybunny-smoke-plugin.git';

export const SILLYBUNNY_BRANCHES = Object.freeze(['release', 'staging']);
export const EXTENSION_DEFAULT_BRANCH = 'main';
export const EXTENSION_SECOND_BRANCH = 'next';
export const PLUGIN_DEFAULT_BRANCH = 'main';
export const PLUGIN_TAG = 'v1.0.0';
export const PLUGIN_ID = 'sillybunny-smoke-plugin';

export const MARKER_PATH = 'android-smoke-marker.txt';
export const MIN_APP_VERSION_PATH = 'android/min-app-version';

/** Refs under this prefix hold commits that are built but not yet published (hidden by the git server). */
export const PENDING_PREFIX = 'refs/fixture/pending/';

const COMMIT_MESSAGE = 'lorum ipsum';
const COMMIT_STEP_SECONDS = 60;
const ZERO_OID = '0'.repeat(40);

/** Builds run under this prefix next to their final place; the git server never routes dot names. */
const STAGING_PREFIX = '.building-';
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 50;
const RENAME_RETRY_MS = 200;

/**
 * Renames a finished repository into place. Windows refuses to rename a directory while a virus
 * scanner or indexer still holds a file inside it, so it retries for a while there.
 * @param {string} from Built repository.
 * @param {string} to Final path.
 */
function renameIntoPlace(from, to) {
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (error) {
            if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) {
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS);
        }
    }
}

/**
 * Builds a repository in a staging directory next to its final place and renames it in only once
 * it is complete, so an interrupted or failed build never leaves a half-built repository behind.
 * @template T
 * @param {string} root Directory that receives the repository.
 * @param {string} name Repository directory name.
 * @param {(repo: string) => T} build Builds the repository at the path it is given.
 * @returns {{path: string, result: T}} Final path and the build's result.
 */
function buildIntoPlace(root, name, build) {
    const destination = path.join(root, name);
    if (fs.existsSync(destination)) {
        throw new Error(`Repository already exists: ${destination}`);
    }
    fs.mkdirSync(root, { recursive: true });
    const staging = fs.mkdtempSync(path.join(root, STAGING_PREFIX));
    try {
        const repo = path.join(staging, name);
        const result = build(repo);
        if (fs.existsSync(destination)) {
            throw new Error(`Repository already exists: ${destination}`);
        }
        renameIntoPlace(repo, destination);
        return { path: destination, result };
    } finally {
        try {
            fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
        } catch {
            // A leftover staging directory is never served or reused.
        }
    }
}

/**
 * Creates an empty bare repository.
 * @param {string} directory Repository directory.
 * @param {string} initialBranch Branch HEAD points at.
 * @returns {string} Repository directory.
 */
export function initBareRepository(directory, initialBranch) {
    runGit(['init', '--bare', '--quiet', `--initial-branch=${initialBranch}`, directory]);
    return directory;
}

/**
 * Resolves a commit, or returns null when the revision does not exist.
 * @param {string} repo Repository.
 * @param {string} revision Revision.
 * @returns {string|null} Commit id.
 */
export function resolveCommit(repo, revision) {
    const result = gitResult(['-C', repo, 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    return result.status === 0 ? result.stdout.trim() : null;
}

function nextCommitTime(repo, parent) {
    if (!parent) {
        return FIXTURE_EPOCH;
    }
    return Number(runGit(['-C', repo, 'show', '-s', '--format=%ct', parent])) + COMMIT_STEP_SECONDS;
}

function datedEnv(time, extra = {}) {
    return createGitEnv({ extra: { GIT_AUTHOR_DATE: gitDate(time), GIT_COMMITTER_DATE: gitDate(time), ...extra } });
}

/**
 * Writes a commit object without a work tree: the parent's tree plus the given file changes.
 * @param {object} options Options.
 * @param {string} options.repo Bare repository.
 * @param {string|null} [options.parent] Parent commit, or null for a root commit.
 * @param {Record<string, string|Buffer|null>} options.files Path to new contents; null deletes the path.
 * @param {number} [options.time] Commit time in seconds (default: parent time plus one minute).
 * @param {string} [options.message] Commit message.
 * @returns {string} New commit id.
 */
export function writeCommit({ repo, parent = null, files, time, message = COMMIT_MESSAGE }) {
    const commitTime = time ?? nextCommitTime(repo, parent);
    const indexFile = path.join(repo, `fixture-index-${randomUUID()}`);
    const env = datedEnv(commitTime, { GIT_INDEX_FILE: indexFile });
    try {
        if (parent) {
            runGit(['-C', repo, 'read-tree', parent], { env });
        }
        const lines = [];
        for (const [file, contents] of Object.entries(files)) {
            if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) {
                throw new Error(`Unsafe fixture path: ${file}`);
            }
            if (contents === null) {
                lines.push(`0 ${ZERO_OID}\t${file}`);
                continue;
            }
            const blob = runGit(['-C', repo, 'hash-object', '-w', '--stdin'], { env, input: contents });
            lines.push(`100644 ${blob}\t${file}`);
        }
        if (lines.length > 0) {
            runGit(['-C', repo, 'update-index', '--index-info'], { env, input: `${lines.join('\n')}\n` });
        }
        const tree = runGit(['-C', repo, 'write-tree'], { env });
        const args = ['-C', repo, 'commit-tree', tree, '-m', message];
        if (parent) {
            args.push('-p', parent);
        }
        return runGit(args, { env });
    } finally {
        fs.rmSync(indexFile, { force: true });
        fs.rmSync(`${indexFile}.lock`, { force: true });
    }
}

/**
 * Applies ref updates in one transaction; each old value is checked first.
 * @param {string} repo Repository.
 * @param {{ref: string, next: string|null, previous?: string|null}[]} updates Updates; next null deletes.
 */
export function updateRefs(repo, updates) {
    const lines = updates.map(({ ref, next, previous }) => {
        const old = previous === undefined ? '' : ` ${previous ?? ZERO_OID}`;
        return next === null ? `delete ${ref}${old}` : `update ${ref} ${next}${old}`;
    });
    runGit(['-C', repo, 'update-ref', '--stdin'], { input: `${lines.join('\n')}\n` });
}

/**
 * Commits file changes on top of a branch and moves the branch (the same effect as a push).
 * @param {object} options Options.
 * @param {string} options.repo Bare repository.
 * @param {string} options.branch Branch name.
 * @param {Record<string, string|Buffer|null>} options.files Path to new contents; null deletes the path.
 * @param {string} [options.message] Commit message.
 * @returns {{branch: string, parent: string|null, commit: string}} Result.
 */
export function commitToBranch({ repo, branch, files, message }) {
    const ref = `refs/heads/${branch}`;
    const parent = resolveCommit(repo, ref);
    const commit = writeCommit({ repo, parent, files, message });
    updateRefs(repo, [{ ref, next: commit, previous: parent }]);
    return { branch, parent, commit };
}

/**
 * Step 4: publishes a new commit that adds or changes a marker file.
 * @param {object} options Options.
 * @param {string} options.repo Bare repository.
 * @param {string} options.branch Branch name.
 * @param {string} [options.marker] Marker path inside the repository.
 * @param {string} [options.contents] Marker contents (default names the branch and parent).
 * @returns {{branch: string, parent: string|null, commit: string, marker: string}} Result.
 */
export function pushMarkerCommit({ repo, branch, marker = MARKER_PATH, contents }) {
    const parent = resolveCommit(repo, `refs/heads/${branch}`);
    const text = contents ?? `${branch} ${parent ?? 'root'}\n`;
    return { ...commitToBranch({ repo, branch, files: { [marker]: text } }), marker };
}

/**
 * Step 5: publishes a commit whose android/min-app-version is one above an installed versionCode.
 * @param {object} options Options.
 * @param {string} options.repo Bare repository.
 * @param {string} options.branch Branch name.
 * @param {number} options.above Installed versionCode to exceed.
 * @returns {{branch: string, parent: string|null, commit: string, minAppVersion: number}} Result.
 */
export function raiseMinAppVersion({ repo, branch, above }) {
    if (!Number.isSafeInteger(above) || above < 0) {
        throw new Error(`Invalid versionCode: ${above}`);
    }
    const minAppVersion = above + 1;
    const result = commitToBranch({ repo, branch, files: { [MIN_APP_VERSION_PATH]: `${minAppVersion}\n` } });
    return { ...result, minAppVersion };
}

/**
 * Reports branch heads, tags (peeled to commits) and unpublished pending commits.
 * @param {string} repo Repository.
 * @returns {{heads: Record<string, string>, tags: Record<string, string>, pending: Record<string, string>}} Refs.
 */
export function readRefs(repo) {
    const output = runGit(['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname) %(*objectname)']);
    const refs = { heads: {}, tags: {}, pending: {} };
    for (const line of output.split('\n').filter(Boolean)) {
        const [name, object, peeled] = line.split(' ');
        if (name.startsWith('refs/heads/')) {
            refs.heads[name.slice('refs/heads/'.length)] = object;
        } else if (name.startsWith('refs/tags/')) {
            refs.tags[name.slice('refs/tags/'.length)] = peeled || object;
        } else if (name.startsWith(PENDING_PREFIX)) {
            refs.pending[name.slice(PENDING_PREFIX.length)] = object;
        }
    }
    return refs;
}

/**
 * Publishes a pending commit: moves the branch to it and drops the pending ref.
 * @param {object} options Options.
 * @param {string} options.repo Bare repository.
 * @param {string} [options.branch] Branch (default: the only pending branch).
 * @returns {{branch: string, parent: string, commit: string}} Result.
 */
export function publishPending({ repo, branch }) {
    const { heads, pending } = readRefs(repo);
    const names = branch ? [branch] : Object.keys(pending);
    if (names.length !== 1 || !pending[names[0]]) {
        throw new Error(`Expected exactly one pending branch in ${repo}, found: ${Object.keys(pending).join(', ') || 'none'}`);
    }
    const name = names[0];
    const commit = pending[name];
    const parent = heads[name] ?? null;
    updateRefs(repo, [
        { ref: `refs/heads/${name}`, next: commit, previous: parent },
        { ref: `${PENDING_PREFIX}${name}`, next: null, previous: commit },
    ]);
    return { branch: name, parent, commit };
}

/**
 * Builds the SillyBunny remote: branches `release` and `staging` at one root commit holding the exact
 * tree of a source commit. The source is only read; the commit is fetched into a temporary repository.
 * The repository appears at its final path only once both branches are written.
 * @param {object} options Options.
 * @param {string} options.root Directory that receives the bare repository.
 * @param {string} options.source Source repository or worktree.
 * @param {string} [options.ref] Source revision (default HEAD).
 * @param {string} [options.name] Repository directory name.
 * @param {readonly string[]} [options.branches] Branches to create.
 * @param {string} [options.tmpDir] Parent directory for the temporary repository.
 * @returns {{name: string, path: string, sourceCommit: string, sourceTree: string, commit: string}} Result.
 */
export function buildSillyBunnyRemote({
    root,
    source,
    ref = 'HEAD',
    name = SILLYBUNNY_REPO,
    branches = SILLYBUNNY_BRANCHES,
    tmpDir = os.tmpdir(),
}) {
    const sourceCommit = runGit(['-C', source, 'rev-parse', '--verify', `${ref}^{commit}`]);
    const sourceTree = runGit(['-C', source, 'rev-parse', '--verify', `${sourceCommit}^{tree}`]);
    const destination = path.join(root, name);
    if (fs.existsSync(destination)) {
        throw new Error(`Repository already exists: ${destination}`);
    }

    fs.mkdirSync(tmpDir, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(tmpDir, 'sb-remote-'));
    try {
        const work = initBareRepository(path.join(temporary, 'work.git'), branches[0]);
        runGit(['-C', work, 'fetch', '--quiet', '--no-tags', '--depth', '1', source, sourceCommit]);
        const commit = runGit(['-C', work, 'commit-tree', sourceTree, '-m', COMMIT_MESSAGE], { env: datedEnv(FIXTURE_EPOCH) });
        const built = buildIntoPlace(root, name, (repo) => {
            initBareRepository(repo, branches[0]);
            // The new root commit has no parents, so the push carries exactly one tree and never the shallow source.
            runGit(['-C', work, 'push', '--quiet', repo, ...branches.map(branch => `${commit}:refs/heads/${branch}`)]);
        });
        return { name, path: built.path, sourceCommit, sourceTree, commit };
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

function json(value, indent = 4) {
    return `${JSON.stringify(value, null, indent)}\n`;
}

/**
 * Files of the fixture UI extension at one revision.
 * @param {{version: string, revision: number, branch: string}} state Revision facts.
 * @returns {Record<string, string>} Files.
 */
export function extensionFiles({ version, revision, branch }) {
    return {
        'manifest.json': json({
            display_name: 'lorum ipsum',
            loading_order: 100,
            requires: [],
            optional: [],
            js: 'index.js',
            css: 'style.css',
            author: 'lorum ipsum',
            version,
            auto_update: false,
        }),
        'index.js': [
            '// Android smoke fixture: lets the test read which revision the app loaded.',
            `globalThis.sillyBunnySmokeExtension = Object.freeze(${JSON.stringify({ version, revision, branch })});`,
            '',
        ].join('\n'),
        'style.css': '.sillybunny-smoke-extension {\n    display: none;\n}\n',
    };
}

/**
 * Builds the fixture extension repository: `main` has one published commit and a second, pending
 * commit for the update step; `next` is a second branch for the branch-switch step.
 * @param {object} options Options.
 * @param {string} options.root Directory that receives the bare repository.
 * @param {string} [options.name] Repository directory name.
 * @returns {{name: string, path: string, commits: {initial: string, update: string, next: string}}} Result.
 */
export function buildExtensionRepo({ root, name = EXTENSION_REPO }) {
    const built = buildIntoPlace(root, name, (directory) => {
        const repo = initBareRepository(directory, EXTENSION_DEFAULT_BRANCH);
        const initial = writeCommit({
            repo,
            files: extensionFiles({ version: '1.0.0', revision: 1, branch: EXTENSION_DEFAULT_BRANCH }),
            time: FIXTURE_EPOCH,
        });
        const update = writeCommit({
            repo,
            parent: initial,
            files: extensionFiles({ version: '1.1.0', revision: 2, branch: EXTENSION_DEFAULT_BRANCH }),
            time: FIXTURE_EPOCH + COMMIT_STEP_SECONDS,
        });
        const next = writeCommit({
            repo,
            parent: initial,
            files: extensionFiles({ version: '2.0.0', revision: 3, branch: EXTENSION_SECOND_BRANCH }),
            time: FIXTURE_EPOCH + 2 * COMMIT_STEP_SECONDS,
        });
        updateRefs(repo, [
            { ref: `refs/heads/${EXTENSION_DEFAULT_BRANCH}`, next: initial, previous: null },
            { ref: `refs/heads/${EXTENSION_SECOND_BRANCH}`, next, previous: null },
            { ref: `${PENDING_PREFIX}${EXTENSION_DEFAULT_BRANCH}`, next: update, previous: null },
        ]);
        return { initial, update, next };
    });
    return { name, path: built.path, commits: built.result };
}

/**
 * Files of the fixture server plugin at one version. The lockfile matches package.json, so
 * `npm ci` succeeds without network access.
 * @param {{version: string, revision: number}} state Revision facts.
 * @returns {Record<string, string>} Files.
 */
export function pluginFiles({ version, revision }) {
    const packageJson = {
        name: PLUGIN_ID,
        version,
        private: true,
        type: 'module',
        main: 'index.js',
        license: 'AGPL-3.0',
        sillybunny: { serverPlugin: { id: PLUGIN_ID } },
    };
    const lockfile = {
        name: PLUGIN_ID,
        version,
        lockfileVersion: 3,
        requires: true,
        packages: {
            '': { name: PLUGIN_ID, version, license: 'AGPL-3.0' },
        },
    };
    return {
        'package.json': json(packageJson, 2),
        'package-lock.json': json(lockfile, 2),
        'index.js': [
            '// Android smoke fixture: a minimal server plugin with a probe route.',
            'export const info = {',
            `    id: '${PLUGIN_ID}',`,
            '    name: \'lorum ipsum\',',
            '    description: \'lorum ipsum\',',
            '};',
            '',
            `const probe = Object.freeze(${JSON.stringify({ id: PLUGIN_ID, version, revision })});`,
            '',
            'export async function init(router) {',
            '    router.get(\'/probe\', (_request, response) => {',
            '        response.json(probe);',
            '    });',
            '}',
            '',
            'export async function exit() {}',
            '',
        ].join('\n'),
    };
}

/**
 * Builds the fixture server plugin repository: `main` has a published commit tagged v1.0.0
 * (with a lockfile) and a later, pending commit for the update step.
 * @param {object} options Options.
 * @param {string} options.root Directory that receives the bare repository.
 * @param {string} [options.name] Repository directory name.
 * @returns {{name: string, path: string, commits: {initial: string, update: string}, tag: string}} Result.
 */
export function buildPluginRepo({ root, name = PLUGIN_REPO }) {
    const built = buildIntoPlace(root, name, (directory) => {
        const repo = initBareRepository(directory, PLUGIN_DEFAULT_BRANCH);
        const initial = writeCommit({ repo, files: pluginFiles({ version: '1.0.0', revision: 1 }), time: FIXTURE_EPOCH });
        const update = writeCommit({
            repo,
            parent: initial,
            files: pluginFiles({ version: '1.1.0', revision: 2 }),
            time: FIXTURE_EPOCH + COMMIT_STEP_SECONDS,
        });
        updateRefs(repo, [
            { ref: `refs/heads/${PLUGIN_DEFAULT_BRANCH}`, next: initial, previous: null },
            { ref: `${PENDING_PREFIX}${PLUGIN_DEFAULT_BRANCH}`, next: update, previous: null },
        ]);
        runGit(['-C', repo, 'tag', '-a', PLUGIN_TAG, '-m', COMMIT_MESSAGE, initial], { env: datedEnv(FIXTURE_EPOCH) });
        return { initial, update };
    });
    return { name, path: built.path, commits: built.result, tag: PLUGIN_TAG };
}
