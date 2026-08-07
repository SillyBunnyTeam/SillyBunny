import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import express from 'express';
import sanitize from 'sanitize-filename';
import { CheckRepoActions, default as simpleGit } from 'simple-git';

import { PUBLIC_DIRECTORIES } from '../constants.js';
import { getConfigValue, isValidUrl } from '../util.js';
import { createGitClient } from '../git/client.js';

const gitBackend = getConfigValue('git.backend', 'auto');
const execFileAsync = promisify(execFile);
const CORE_EXTENSIONS = new Set([
    'translate',
    'connection-manager',
    'regex',
    'attachments',
    'caption',
    'gallery',
    'quick-reply',
    'assets',
    'token-counter',
    'vectors',
    'in-chat-agents',
    'sillybunny-debugger',
]);
const BUNDLED_THIRD_PARTY_EXTENSIONS = new Set([
    'bunnypresettools',
    'chatcompletiontabs',
]);
const MANUAL_SYNC_EXTENSIONS = new Map([
    ['quick-image-gen', {
        script: path.resolve('scripts/sync-quick-image-gen.sh'),
        repo: 'https://github.com/platberlitz/sillytavern-image-gen',
    }],
]);

/**
 * @type {Partial<import('simple-git').SimpleGitOptions>}
 */
const OPTIONS = Object.freeze({ timeout: { block: 5 * 60 * 1000 } });

/**
 * This function extracts the extension information from the manifest file.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<Object>} - Returns the manifest data as an object
 */
async function getManifest(extensionPath) {
    const manifestPath = path.join(extensionPath, 'manifest.json');

    // Check if manifest.json exists
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Manifest file not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest;
}

function getManifestRepoUrl(manifest) {
    const candidate = manifest?.homepage || manifest?.homePage;

    if (typeof candidate !== 'string' || !candidate) {
        return '';
    }

    try {
        const url = new URL(candidate);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return '';
        }

        return url.href;
    } catch {
        return '';
    }
}

function clearDirectoryContents(directoryPath, keep = new Set()) {
    for (const entry of fs.readdirSync(directoryPath)) {
        if (keep.has(entry)) {
            continue;
        }

        fs.rmSync(path.join(directoryPath, entry), { recursive: true, force: true });
    }
}

function copyDirectoryContents(sourcePath, destinationPath) {
    for (const entry of fs.readdirSync(sourcePath)) {
        if (entry === '.git') {
            continue;
        }

        fs.cpSync(path.join(sourcePath, entry), path.join(destinationPath, entry), { recursive: true, force: true });
    }
}

async function getRemoteDefaultBranch(git) {
    try {
        await git.raw(['remote', 'set-head', 'origin', '-a']);
    } catch {
        // Fall through to the branch-list fallback below.
    }

    try {
        const symbolicRef = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
        if (symbolicRef.startsWith('origin/')) {
            return symbolicRef.replace(/^origin\//, '');
        }
    } catch {
        // Fall through to the branch-list fallback below.
    }

    const remoteBranches = await git.branch(['-r']);
    const preferredBranch = ['main', 'master'].find(branch => remoteBranches.all.includes(`origin/${branch}`));
    if (preferredBranch) {
        return preferredBranch;
    }

    const firstRemoteBranch = remoteBranches.all.find(branch => branch.startsWith('origin/') && branch !== 'origin/HEAD');
    if (!firstRemoteBranch) {
        throw new Error('Could not determine the default remote branch.');
    }

    return firstRemoteBranch.replace(/^origin\//, '');
}

async function ensureExtensionRepo(extensionPath, isGlobal = false) {
    const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
    try {
        const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (isRepo) {
            return true;
        }
    } catch {
        // Continue into the bootstrap path below.
    }

    if (!isGlobal) {
        return false;
    }

    const manifest = await getManifest(extensionPath).catch(() => null);
    const repoUrl = getManifestRepoUrl(manifest);
    if (!repoUrl) {
        return false;
    }

    const snapshotPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-ext-'));

    try {
        copyDirectoryContents(extensionPath, snapshotPath);

        await git.init();
        await git.addRemote('origin', repoUrl);
        clearDirectoryContents(extensionPath, new Set(['.git']));
        await git.raw(['fetch', '--depth', '1', 'origin']);

        const defaultBranch = await getRemoteDefaultBranch(git);
        await git.checkout(['-B', defaultBranch, `origin/${defaultBranch}`]);

        copyDirectoryContents(snapshotPath, extensionPath);
        await git.raw(['config', 'user.name', 'SillyBunny']);
        await git.raw(['config', 'user.email', 'sillybunny@local']);
        await git.add('.');

        const status = await git.status();
        if (status.files.length > 0) {
            await git.commit('SillyBunny bundled adjustments');
        }

        console.info(`Bootstrapped bundled extension repo at ${extensionPath} from ${repoUrl}`);
        return true;
    } catch (error) {
        clearDirectoryContents(extensionPath, new Set(['.git']));
        copyDirectoryContents(snapshotPath, extensionPath);
        fs.rmSync(path.join(extensionPath, '.git'), { recursive: true, force: true });
        console.error(`Failed to bootstrap bundled extension repo at ${extensionPath}`, error);
        return false;
    } finally {
        fs.rmSync(snapshotPath, { recursive: true, force: true });
    }
}

export function isBundledThirdPartyExtension(extensionName) {
    const sanitizedName = sanitize(String(extensionName).split(/[\\/]/).pop() ?? '');
    return BUNDLED_THIRD_PARTY_EXTENSIONS.has(sanitizedName.toLowerCase());
}

function getBuiltInExtensionType(extensionName) {
    const sanitizedName = sanitize(extensionName);
    return CORE_EXTENSIONS.has(sanitizedName) ? 'core' : 'system';
}

export function rejectBundledThirdPartyExtension(extensionName, response, action) {
    if (!isBundledThirdPartyExtension(extensionName)) {
        return false;
    }

    response.status(400).send(`Bad Request: ${extensionName} is bundled with SillyBunny and cannot be ${action} through the extension updater.`);
    return true;
}

/**
 * This function checks if the local repository is up-to-date with the remote repository.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<Object>} - Returns the extension information as an object
 */
async function checkIfRepoIsUpToDate(extensionPath) {
    const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
    await git.fetch('origin');
    const currentBranch = await git.branch();

    // Fetch remote repository information
    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
        return {
            isUpToDate: true,
            remoteUrl: '',
        };
    }

    const trackingBranch = currentBranch.tracking || (currentBranch.current ? `origin/${currentBranch.current}` : '');
    if (!trackingBranch) {
        return {
            isUpToDate: true,
            remoteUrl: remotes[0].refs.fetch,
        };
    }

    // Only treat the repo as outdated when the remote has commits we do not have yet.
    // Bundled extensions can legitimately be ahead of upstream because SillyBunny patches them locally.
    const [, behindRaw = '0'] = (await git.raw(['rev-list', '--left-right', '--count', `HEAD...${trackingBranch}`]))
        .trim()
        .split(/\s+/);
    const behindCount = Number(behindRaw);
    const isUpToDate = !Number.isFinite(behindCount) || behindCount === 0;

    return {
        isUpToDate,
        remoteUrl: remotes[0].refs.fetch, // URL of the remote repository
    };
}

export const router = express.Router();

/**
 * Feature flag guard: don't allow calling any of the endpoints if extensions are disabled
 * @type {import('express').RequestHandler}
 */
export const extensionsEnabledFeatureGuard = (_, response, next) => {
    const enabled = !!getConfigValue('extensions.enabled', true, 'boolean');
    if (!enabled) {
        response.sendStatus(404);
        return;
    }
    next();
};

router.use(extensionsEnabledFeatureGuard);

/**
 * HTTP POST handler function to clone a git repository from a provided URL, read the extension manifest,
 * and return extension information and path.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'url' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/install', async (request, response) => {
    try {
        const { url, global, branch } = request.body;

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to install global extensions.`);
            return response.status(403).send('Forbidden: No permission to install global extensions.');
        }

        if (!isValidUrl(url)) {
            return response.status(400).send('Bad Request: A valid URL is required in the request body.');
        }

        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return response.status(400).send('Bad Request: Only HTTP and HTTPS protocols are supported for the Extension URL.');
        }

        const git = createGitClient({ backend: gitBackend });

        // make sure the third-party directory exists
        if (!fs.existsSync(path.join(request.user.directories.extensions))) {
            fs.mkdirSync(path.join(request.user.directories.extensions));
        }

        if (!fs.existsSync(PUBLIC_DIRECTORIES.globalExtensions)) {
            fs.mkdirSync(PUBLIC_DIRECTORIES.globalExtensions);
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionNameSanitized = sanitize(path.basename(parsedUrl.pathname, '.git'));
        if (!extensionNameSanitized) {
            return response.status(400).send('Could not determine the extension name from the URL. Please provide a valid git repository URL.');
        }

        const extensionPath = path.join(basePath, extensionNameSanitized);
        const folderName = path.basename(extensionPath);

        if (fs.existsSync(extensionPath)) {
            return response.status(409).send(`Directory already exists at ${extensionPath}`);
        }

        const cloneOptions = { depth: 1 };
        if (branch) {
            cloneOptions.branch = branch;
        }
        await git.clone(parsedUrl.href, extensionPath, cloneOptions);
        console.info(`Extension has been cloned to ${extensionPath} from ${parsedUrl.href} at ${branch || '(default)'} branch`);

        try {
            const manifest = await getManifest(extensionPath);
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('Manifest is not a valid JSON object.');
            }
            const { version, author, display_name } = manifest;
            return response.send({ version, author, display_name, extensionPath, folderName });
        } catch (manifestError) {
            await fs.promises.rm(extensionPath, { recursive: true, force: true });
            throw manifestError;
        }
    } catch (error) {
        console.error('Importing extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to pull the latest updates from a git repository
 * based on the extension name provided in the request body. It returns the latest commit hash,
 * the path of the extension, the status of the repository (whether it's up-to-date or not),
 * and the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/update', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }
        if (rejectBundledThirdPartyExtension(extensionNameSanitized, response, 'updated')) {
            return;
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to update global extensions.`);
            return response.status(403).send('Forbidden: No permission to update global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await ensureExtensionRepo(extensionPath, global);

        const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(extensionPath);
        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (!isRepo) {
            throw new Error(`Directory is not a Git repository at ${extensionPath}`);
        }

        const autoStash = getConfigValue('autoStashBeforePull', false, 'boolean');
        const gitStatus = await git.status();
        let stashed = false;
        let stashPopWarning = null;

        if (!gitStatus.isClean() && autoStash) {
            try {
                await git.stash(['push', '-m', `SillyBunny auto-stash before extension update (${extensionName})`]);
                stashed = true;
                console.info(`Local changes stashed before updating extension at ${extensionPath}`);
            } catch (stashError) {
                console.warn(`Failed to stash local changes for extension at ${extensionPath}`, stashError);
            }
        }

        const currentBranch = await git.branch();
        if (!isUpToDate) {
            await git.pull('origin', currentBranch.current);
            console.info(`Extension has been updated at ${extensionPath}`);
        } else {
            console.info(`Extension is up to date at ${extensionPath}`);
        }

        if (stashed) {
            try {
                await git.stash(['pop']);
                console.info(`Stashed changes restored for extension at ${extensionPath}`);
            } catch (popError) {
                stashPopWarning = `Extension updated, but local changes could not be restored: ${popError.message}. Changes remain in git stash.`;
                console.warn(stashPopWarning);
            }
        }

        await git.fetch('origin');
        const fullCommitHash = await git.revparse(['HEAD']);
        const shortCommitHash = fullCommitHash.slice(0, 7);

        return response.send({ shortCommitHash, extensionPath, isUpToDate, remoteUrl, stashed, stashPopWarning });
    } catch (error) {
        console.error('Updating extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/branches', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }
        if (rejectBundledThirdPartyExtension(extensionNameSanitized, response, 'managed')) {
            return;
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to list branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to list branches of global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await ensureExtensionRepo(extensionPath, global);

        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        // Unshallow the repository if it is shallow
        const isShallow = await git.revparse(['--is-shallow-repository']) === 'true';
        if (isShallow) {
            console.info(`Unshallowing the repository at ${extensionPath}`);
            await git.fetch('origin', ['--unshallow']);
        }

        // Fetch all branches
        await git.remote(['set-branches', 'origin', '*']);
        await git.fetch('origin');
        const localBranches = await git.branchLocal();
        const remoteBranches = await git.branch(['-r', '--list', 'origin/*']);
        const result = [
            ...Object.values(localBranches.branches),
            ...Object.values(remoteBranches.branches),
        ].map(b => ({ current: b.current, commit: b.commit, name: b.name, label: b.label }));

        return response.send(result);
    } catch (error) {
        console.error('Getting branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/switch', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, branch, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized || !branch) {
            return response.status(400).send('Bad Request: A valid extensionName and branch are required in the request body.');
        }
        if (rejectBundledThirdPartyExtension(extensionNameSanitized, response, 'switched')) {
            return;
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to switch branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to switch branches of global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await ensureExtensionRepo(extensionPath, global);

        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        const branches = await git.branchLocal();

        if (String(branch).startsWith('origin/')) {
            const localBranch = branch.replace('origin/', '');
            if (branches.all.includes(localBranch)) {
                console.info(`Branch ${localBranch} already exists locally, checking it out`);
                await git.checkout(localBranch);
                return response.sendStatus(204);
            }

            console.info(`Branch ${localBranch} does not exist locally, creating it from ${branch}`);
            await git.checkoutBranch(localBranch, branch);
            return response.sendStatus(204);
        }

        if (!branches.all.includes(branch)) {
            console.error(`Branch ${branch} does not exist locally`);
            return response.status(404).send(`Branch ${branch} does not exist locally`);
        }

        // Check if the branch is already checked out
        const currentBranch = await git.branch();
        if (currentBranch.current === branch) {
            console.info(`Branch ${branch} is already checked out`);
            return response.sendStatus(204);
        }

        // Checkout the branch
        await git.checkout(branch);
        console.info(`Checked out branch ${branch} at ${extensionPath}`);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Switching branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/move', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, source, destination } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized || !source || !destination) {
            return response.status(400).send('Bad Request: A valid extensionName, source, and destination are required in the request body.');
        }
        if (rejectBundledThirdPartyExtension(extensionNameSanitized, response, 'moved')) {
            return;
        }

        if (!request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to move extensions.`);
            return response.status(403).send('Forbidden: No permission to move extensions.');
        }

        const sourceDirectory = source === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const destinationDirectory = destination === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const sourcePath = path.join(sourceDirectory, extensionNameSanitized);
        const destinationPath = path.join(destinationDirectory, extensionNameSanitized);

        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
            console.error(`Source directory does not exist at ${sourcePath}`);
            return response.status(404).send('Source directory does not exist.');
        }

        if (fs.existsSync(destinationPath)) {
            console.error(`Destination directory already exists at ${destinationPath}`);
            return response.status(409).send('Destination directory already exists.');
        }

        if (source === destination) {
            console.error('Source and destination directories are the same');
            return response.status(409).send('Source and destination directories are the same.');
        }

        fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
        fs.rmSync(sourcePath, { recursive: true, force: true });
        console.info(`Extension has been moved from ${sourcePath} to ${destinationPath}`);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Moving extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to get the current git commit hash and branch name for a given extension.
 * It checks whether the repository is up-to-date with the remote, and returns the status along with
 * the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/version', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }
        if (isBundledThirdPartyExtension(extensionNameSanitized)) {
            return response.send({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' });
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await ensureExtensionRepo(extensionPath, global);

        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        let currentCommitHash;
        try {
            const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
            if (!isRepo) {
                throw new Error(`Directory is not a Git repository at ${extensionPath}`);
            }
            currentCommitHash = await git.revparse(['HEAD']);
        } catch (error) {
            // it is not a git repo, or has no commits yet, or is a bare repo
            // not possible to update it, most likely can't get the branch name either
            return response.send({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' });
        }

        const currentBranch = await git.branch();
        // get only the working branch
        const currentBranchName = currentBranch.current;
        await git.fetch('origin');
        console.debug(extensionNameSanitized, currentBranchName, currentCommitHash);
        const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(extensionPath);

        return response.send({ currentBranchName, currentCommitHash, isUpToDate, remoteUrl });
    } catch (error) {
        console.error('Getting extension version failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/sync', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const extensionNameSanitized = sanitize(request.body.extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        if (!request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to sync bundled extensions.`);
            return response.status(403).send('Forbidden: No permission to sync bundled extensions.');
        }

        const syncConfig = MANUAL_SYNC_EXTENSIONS.get(extensionNameSanitized);
        if (!syncConfig) {
            return response.status(400).send(`Bad Request: ${extensionNameSanitized} does not support manual sync.`);
        }

        const extensionPath = path.join(PUBLIC_DIRECTORIES.extensions, extensionNameSanitized);
        const manifest = await getManifest(extensionPath);
        if (manifest.auto_update !== true) {
            return response.status(400).send(`Bad Request: ${extensionNameSanitized} is not configured for manual sync.`);
        }

        const repoUrl = getManifestRepoUrl(manifest).replace(/\/$/, '');
        if (repoUrl !== syncConfig.repo) {
            return response.status(400).send(`Bad Request: ${extensionNameSanitized} sync source must be ${syncConfig.repo}.`);
        }

        const metadataPath = path.join(os.tmpdir(), `sillybunny-${extensionNameSanitized}-${Date.now()}.env`);
        try {
            const { stdout, stderr } = await execFileAsync('bash', [syncConfig.script, '--metadata-file', metadataPath], {
                cwd: process.cwd(),
                timeout: 5 * 60 * 1000,
                maxBuffer: 1024 * 1024,
            });

            const metadata = fs.existsSync(metadataPath) ? fs.readFileSync(metadataPath, 'utf8') : '';
            const version = metadata.match(/^QIG_VERSION=(.*)$/m)?.[1] || '';
            const shortCommitHash = metadata.match(/^QIG_SHORT_COMMIT=(.*)$/m)?.[1] || '';
            return response.send({ stdout, stderr, version, shortCommitHash });
        } finally {
            fs.rmSync(metadataPath, { force: true });
        }
    } catch (error) {
        console.error('Syncing extension failed', error);
        return response.status(500).send(error.stderr || error.message || 'Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to delete a git repository based on the extension name provided in the request body.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/delete', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }
        if (rejectBundledThirdPartyExtension(extensionNameSanitized, response, 'deleted')) {
            return;
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to delete global extensions.`);
            return response.status(403).send('Forbidden: No permission to delete global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await fs.promises.rm(extensionPath, { recursive: true });
        console.info(`Extension has been deleted at ${extensionPath}`);

        return response.send(`Extension has been deleted at ${extensionPath}`);
    } catch (error) {
        console.error('Deleting extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * Discover the extension folders
 * If the folder is called third-party, search for subfolders instead
 */
router.get('/discover', function (request, response) {
    if (!fs.existsSync(path.join(request.user.directories.extensions))) {
        fs.mkdirSync(path.join(request.user.directories.extensions));
    }

    if (!fs.existsSync(PUBLIC_DIRECTORIES.globalExtensions)) {
        fs.mkdirSync(PUBLIC_DIRECTORIES.globalExtensions);
    }

    // Get all folders in system extensions folder, excluding third-party
    const builtInExtensions = fs
        .readdirSync(PUBLIC_DIRECTORIES.extensions)
        .filter(f => fs.statSync(path.join(PUBLIC_DIRECTORIES.extensions, f)).isDirectory())
        .filter(f => f !== 'third-party')
        .map(f => ({ type: getBuiltInExtensionType(f), name: f }));

    // Get all folders in local extensions folder
    const userExtensions = fs
        .readdirSync(path.join(request.user.directories.extensions))
        .filter(f => fs.statSync(path.join(request.user.directories.extensions, f)).isDirectory())
        .filter(f => !isBundledThirdPartyExtension(f))
        .map(f => ({ type: 'local', name: `third-party/${f}` }));

    // Get all folders in global extensions folder
    // In case of a conflict, the extension will be loaded from the user folder
    const globalExtensions = fs
        .readdirSync(PUBLIC_DIRECTORIES.globalExtensions)
        .filter(f => fs.statSync(path.join(PUBLIC_DIRECTORIES.globalExtensions, f)).isDirectory())
        .map(f => ({ type: isBundledThirdPartyExtension(f) ? 'bundled' : 'global', name: `third-party/${f}` }))
        .filter(f => !userExtensions.some(e => e.name === f.name));

    // Combine all extensions
    const allExtensions = [...builtInExtensions, ...userExtensions, ...globalExtensions];
    console.debug('Extensions available for', request.user.profile.handle, allExtensions);

    return response.send(allExtensions);
});
