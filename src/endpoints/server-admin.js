import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import express from 'express';
import yaml from 'yaml';
import { sync as commandExistsSync } from 'command-exists';
import simpleGit from 'simple-git';

import { APP_NAME, formatRuntimeLabel, isBunRuntime, isNativeTermuxEnvironment } from '../runtime.js';
import {
    getBranchDisplayNames,
    getGeneratedInstallChangePaths,
    getRemoteBranchesFromSummary,
    getStatusDisplayBranch,
    NON_GIT_REPOSITORY_MESSAGE,
    isRuntimeBranch,
    isGitRepository,
    resolveRemoteBranchName,
} from '../server-admin-git.js';
import { getServerLogSnapshot } from '../server-log-buffer.js';
import { getLatestZipReleaseStatus, stageZipReleaseUpdate } from '../server-admin-zip-update.js';
import { serverDirectory } from '../server-directory.js';
import { requireAdminMiddleware } from '../users.js';
import { getConfigValue, getVersion, isPathUnderParent, tryWriteFileSync } from '../util.js';
import { getThumbnailDimensions, getThumbnailMobileDimensions, setThumbnailDimensions, setThumbnailMobileDimensions } from './image-metadata.js';
import { getThumbnailMobileRuntimeSettings, getThumbnailRuntimeSettings, setThumbnailMobileRuntimeSettings, setThumbnailRuntimeSettings } from './thumbnails.js';
import { requestGracefulExit } from '../shutdown.js';
import { getServerBootId } from '../server-boot-marker.js';
import {
    LAUNCHER_ENV as RESTART_LAUNCHER_ENV,
    RESTART_EXIT_CODE,
    SUPERVISED_ENV as RESTART_SUPERVISED_ENV,
} from '../server-supervisor.js';

const GIT_OPTIONS = Object.freeze({ timeout: { block: 10 * 60 * 1000 } });
const RESTART_RESPONSE_DELAY_MS = 200;
const CHAT_COMPLETION_CONFIG_DEFAULTS = Object.freeze({
    claude: Object.freeze({
        enableSystemPromptCache: false,
        cachingAtDepth: -1,
        extendedTTL: false,
        enableAdaptiveThinking: true,
    }),
    gemini: Object.freeze({
        apiVersion: 'v1beta',
        thoughtSignatures: true,
        enableSystemPromptCache: false,
    }),
});
const THUMBNAIL_CONFIG_DEFAULTS = Object.freeze({
    enabled: true,
    format: 'png',
    quality: 100,
    dimensions: Object.freeze({
        bg: Object.freeze([240, 135]),
        avatar: Object.freeze([864, 1280]),
        persona: Object.freeze([864, 1280]),
    }),
});
const SILLYBUNNY_RECOMMENDED_THUMBNAILS = Object.freeze({
    enabled: true,
    format: 'png',
    quality: 100,
    dimensions: Object.freeze({
        bg: Object.freeze([240, 135]),
        avatar: Object.freeze([864, 1280]),
        persona: Object.freeze([864, 1280]),
    }),
});
const THUMBNAIL_MOBILE_CONFIG_DEFAULTS = Object.freeze({
    enabled: true,
    format: 'jpg',
    quality: 82,
    dimensions: Object.freeze({
        bg: Object.freeze([240, 135]),
        avatar: Object.freeze([320, 480]),
        persona: Object.freeze([320, 480]),
    }),
});
const SILLYBUNNY_RECOMMENDED_THUMBNAILS_MOBILE = Object.freeze({
    enabled: true,
    format: 'jpg',
    quality: 82,
    dimensions: Object.freeze({
        bg: Object.freeze([240, 135]),
        avatar: Object.freeze([320, 480]),
        persona: Object.freeze([320, 480]),
    }),
});

export const router = express.Router();

function getConfigFilePath() {
    const configPath = globalThis.COMMAND_LINE_ARGS?.configPath;
    return path.resolve(configPath || path.join(serverDirectory, 'config.yaml'));
}

function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function toTrimmedString(value) {
    return String(value ?? '').trim();
}

function normalizeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(numericValue)));
}

function normalizeThumbnailDimensionsPair(value, fallback) {
    const plainValue = typeof value?.toJSON === 'function' ? value.toJSON() : value;
    const source = Array.isArray(plainValue) ? plainValue : fallback;
    return [
        normalizeInteger(source?.[0], { min: 1, max: 4096, fallback: fallback[0] }),
        normalizeInteger(source?.[1], { min: 1, max: 4096, fallback: fallback[1] }),
    ];
}

function normalizeThumbnailSettingsInput(settings = {}, { mobile = false } = {}) {
    const defaults = mobile ? THUMBNAIL_MOBILE_CONFIG_DEFAULTS : THUMBNAIL_CONFIG_DEFAULTS;
    const format = String(settings?.format ?? defaults.format).toLowerCase().trim() === 'png' ? 'png' : 'jpg';
    return {
        enabled: Boolean(settings?.enabled ?? defaults.enabled),
        format,
        quality: normalizeInteger(settings?.quality, { min: 1, max: 100, fallback: defaults.quality }),
        dimensions: {
            bg: normalizeThumbnailDimensionsPair(settings?.dimensions?.bg, defaults.dimensions.bg),
            avatar: normalizeThumbnailDimensionsPair(settings?.dimensions?.avatar, defaults.dimensions.avatar),
            persona: normalizeThumbnailDimensionsPair(settings?.dimensions?.persona, defaults.dimensions.persona),
        },
    };
}

function truncateOutput(value, maxLength = 6000) {
    const text = String(value ?? '').trim();
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 1).trimEnd()}\n…`;
}

function readConfigDocument() {
    const configPath = getConfigFilePath();

    if (!fs.existsSync(configPath)) {
        throw createHttpError(404, `Config file not found at ${configPath}`);
    }

    const stat = fs.statSync(configPath);
    const content = fs.readFileSync(configPath, 'utf8');
    const document = yaml.parseDocument(content, { prettyErrors: true });

    if (document.errors.length > 0) {
        throw createHttpError(400, document.errors.map(error => error.message).join('\n\n'));
    }

    return {
        configPath,
        stat,
        content,
        document,
    };
}

function ensureExpectedConfigMtime(stat, expectedLastModifiedMs) {
    if (Number.isFinite(expectedLastModifiedMs) && Math.trunc(stat.mtimeMs) !== Math.trunc(expectedLastModifiedMs)) {
        throw createHttpError(409, 'config.yaml changed on disk. Reload it before saving again.');
    }
}

function writeConfigDocument(configPath, document) {
    const nextContent = document.toString();
    const serializedContent = nextContent.endsWith('\n') ? nextContent : `${nextContent}\n`;
    tryWriteFileSync(configPath, serializedContent);
    return fs.statSync(configPath);
}

function getChatCompletionConfigState(document) {
    const claudeNode = document.getIn(['claude']) ?? {};
    const geminiNode = document.getIn(['gemini']) ?? {};

    const cachingAtDepth = Number.parseInt(String(claudeNode?.cachingAtDepth ?? CHAT_COMPLETION_CONFIG_DEFAULTS.claude.cachingAtDepth), 10);

    return {
        claude: {
            enableSystemPromptCache: Boolean(claudeNode?.enableSystemPromptCache ?? CHAT_COMPLETION_CONFIG_DEFAULTS.claude.enableSystemPromptCache),
            cachingAtDepth: Number.isFinite(cachingAtDepth) ? cachingAtDepth : CHAT_COMPLETION_CONFIG_DEFAULTS.claude.cachingAtDepth,
            extendedTTL: Boolean(claudeNode?.extendedTTL ?? CHAT_COMPLETION_CONFIG_DEFAULTS.claude.extendedTTL),
            enableAdaptiveThinking: Boolean(claudeNode?.enableAdaptiveThinking ?? CHAT_COMPLETION_CONFIG_DEFAULTS.claude.enableAdaptiveThinking),
        },
        gemini: {
            apiVersion: toTrimmedString(geminiNode?.apiVersion || CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.apiVersion) || CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.apiVersion,
            thoughtSignatures: Boolean(geminiNode?.thoughtSignatures ?? CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.thoughtSignatures),
            enableSystemPromptCache: Boolean(geminiNode?.enableSystemPromptCache ?? CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.enableSystemPromptCache),
        },
    };
}

function getThumbnailConfigState(document) {
    const getConfig = (pathParts, fallback) => document.getIn(pathParts) ?? fallback;
    return normalizeThumbnailSettingsInput({
        enabled: getConfig(['thumbnails', 'enabled'], THUMBNAIL_CONFIG_DEFAULTS.enabled),
        format: getConfig(['thumbnails', 'format'], THUMBNAIL_CONFIG_DEFAULTS.format),
        quality: getConfig(['thumbnails', 'quality'], THUMBNAIL_CONFIG_DEFAULTS.quality),
        dimensions: {
            bg: getConfig(['thumbnails', 'dimensions', 'bg'], THUMBNAIL_CONFIG_DEFAULTS.dimensions.bg),
            avatar: getConfig(['thumbnails', 'dimensions', 'avatar'], THUMBNAIL_CONFIG_DEFAULTS.dimensions.avatar),
            persona: getConfig(['thumbnails', 'dimensions', 'persona'], THUMBNAIL_CONFIG_DEFAULTS.dimensions.persona),
        },
    });
}

function getThumbnailMobileConfigState(document) {
    const getConfig = (pathParts, fallback) => document.getIn(pathParts) ?? fallback;
    return normalizeThumbnailSettingsInput({
        enabled: getConfig(['thumbnails', 'mobile', 'enabled'], THUMBNAIL_MOBILE_CONFIG_DEFAULTS.enabled),
        format: getConfig(['thumbnails', 'mobile', 'format'], THUMBNAIL_MOBILE_CONFIG_DEFAULTS.format),
        quality: getConfig(['thumbnails', 'mobile', 'quality'], THUMBNAIL_MOBILE_CONFIG_DEFAULTS.quality),
        dimensions: {
            bg: getConfig(['thumbnails', 'mobile', 'dimensions', 'bg'], THUMBNAIL_MOBILE_CONFIG_DEFAULTS.dimensions.bg),
            avatar: getConfig(['thumbnails', 'mobile', 'dimensions', 'avatar'], THUMBNAIL_MOBILE_CONFIG_DEFAULTS.dimensions.avatar),
            persona: getConfig(['thumbnails', 'mobile', 'dimensions', 'persona'], THUMBNAIL_MOBILE_CONFIG_DEFAULTS.dimensions.persona),
        },
    }, { mobile: true });
}

function applyThumbnailConfigState(document, settings, mobileSettings) {
    document.setIn(['thumbnails', 'enabled'], settings.enabled);
    document.setIn(['thumbnails', 'format'], settings.format);
    document.setIn(['thumbnails', 'quality'], settings.quality);
    document.setIn(['thumbnails', 'dimensions', 'bg'], settings.dimensions.bg);
    document.setIn(['thumbnails', 'dimensions', 'avatar'], settings.dimensions.avatar);
    document.setIn(['thumbnails', 'dimensions', 'persona'], settings.dimensions.persona);

    document.setIn(['thumbnails', 'mobile', 'enabled'], mobileSettings.enabled);
    document.setIn(['thumbnails', 'mobile', 'format'], mobileSettings.format);
    document.setIn(['thumbnails', 'mobile', 'quality'], mobileSettings.quality);
    document.setIn(['thumbnails', 'mobile', 'dimensions', 'bg'], mobileSettings.dimensions.bg);
    document.setIn(['thumbnails', 'mobile', 'dimensions', 'avatar'], mobileSettings.dimensions.avatar);
    document.setIn(['thumbnails', 'mobile', 'dimensions', 'persona'], mobileSettings.dimensions.persona);
}

function applyThumbnailRuntimeConfig(settings, mobileSettings) {
    setThumbnailRuntimeSettings(settings);
    setThumbnailDimensions(settings.dimensions);
    setThumbnailMobileRuntimeSettings(mobileSettings);
    setThumbnailMobileDimensions(mobileSettings.dimensions);
}

function countFilesRecursively(directory) {
    if (!fs.existsSync(directory)) {
        return 0;
    }

    let count = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            count += countFilesRecursively(entryPath);
        } else if (entry.isFile()) {
            count++;
        }
    }
    return count;
}

function clearDirectoryContents(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
        return;
    }

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        fs.rmSync(path.join(directory, entry.name), { recursive: true, force: true });
    }
}

function clearThumbnailCacheForUser(directories) {
    const userRoot = path.resolve(directories.root);
    const thumbnailRoot = path.resolve(directories.thumbnails);
    const thumbnailSubdirectories = [directories.thumbnailsBg, directories.thumbnailsAvatar, directories.thumbnailsPersona, directories.thumbnailsAvatarMobile, directories.thumbnailsPersonaMobile]
        .map(directory => path.resolve(directory));

    if (thumbnailRoot === userRoot || !isPathUnderParent(userRoot, thumbnailRoot)) {
        throw createHttpError(400, 'Thumbnail directory is outside the active user data folder.');
    }

    for (const directory of thumbnailSubdirectories) {
        if (directory === thumbnailRoot || !isPathUnderParent(thumbnailRoot, directory)) {
            throw createHttpError(400, 'Thumbnail subdirectory is outside the thumbnail cache folder.');
        }
    }

    const filesDeleted = countFilesRecursively(thumbnailRoot);
    clearDirectoryContents(thumbnailRoot);

    for (const directory of thumbnailSubdirectories) {
        fs.mkdirSync(directory, { recursive: true });
    }

    return {
        directory: thumbnailRoot,
        filesDeleted,
    };
}

function normalizeChatCompletionConfigInput(settings) {
    const cachingAtDepth = Number.parseInt(String(settings?.claude?.cachingAtDepth ?? CHAT_COMPLETION_CONFIG_DEFAULTS.claude.cachingAtDepth), 10);

    return {
        claude: {
            enableSystemPromptCache: Boolean(settings?.claude?.enableSystemPromptCache),
            cachingAtDepth: Number.isFinite(cachingAtDepth) ? cachingAtDepth : CHAT_COMPLETION_CONFIG_DEFAULTS.claude.cachingAtDepth,
            extendedTTL: Boolean(settings?.claude?.extendedTTL),
            enableAdaptiveThinking: Boolean(settings?.claude?.enableAdaptiveThinking ?? CHAT_COMPLETION_CONFIG_DEFAULTS.claude.enableAdaptiveThinking),
        },
        gemini: {
            apiVersion: toTrimmedString(settings?.gemini?.apiVersion || CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.apiVersion) || CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.apiVersion,
            thoughtSignatures: Boolean(settings?.gemini?.thoughtSignatures ?? CHAT_COMPLETION_CONFIG_DEFAULTS.gemini.thoughtSignatures),
            enableSystemPromptCache: Boolean(settings?.gemini?.enableSystemPromptCache),
        },
    };
}

function applyChatCompletionConfigState(document, settings) {
    document.setIn(['claude', 'enableSystemPromptCache'], settings.claude.enableSystemPromptCache);
    document.setIn(['claude', 'cachingAtDepth'], settings.claude.cachingAtDepth);
    document.setIn(['claude', 'extendedTTL'], settings.claude.extendedTTL);
    document.setIn(['claude', 'enableAdaptiveThinking'], settings.claude.enableAdaptiveThinking);
    document.setIn(['gemini', 'apiVersion'], settings.gemini.apiVersion);
    document.setIn(['gemini', 'thoughtSignatures'], settings.gemini.thoughtSignatures);
    document.setIn(['gemini', 'enableSystemPromptCache'], settings.gemini.enableSystemPromptCache);
}

function getZipUpdatePayload(stagedUpdate) {
    const payload = {
        parentPid: process.pid,
        supervisorPid: process.env[RESTART_SUPERVISED_ENV] === '1' ? process.ppid : null,
        installDir: serverDirectory,
        stagingRoot: stagedUpdate.stagingRoot,
        releaseRoot: stagedUpdate.releaseRoot,
        version: stagedUpdate.version,
        assetName: stagedUpdate.assetName,
        command: [process.argv[0], ...process.argv.slice(1)],
        // Clear the supervision markers so the relaunched server.js starts a
        // fresh supervisor instead of expecting a loop that no longer exists.
        envPatch: {
            SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH: '1',
            [RESTART_SUPERVISED_ENV]: '',
            [RESTART_LAUNCHER_ENV]: '',
        },
        visibleRelaunch: process.platform === 'win32',
    };

    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function isManagedRestart() {
    return process.env[RESTART_LAUNCHER_ENV] === '1' || process.env[RESTART_SUPERVISED_ENV] === '1';
}

function scheduleRestart(response) {
    // Either a launcher script (Start.bat/start.sh) or the server.js
    // supervisor watches for the restart exit code. Direct launches are
    // supervised since server.js became self-supervising, so exiting with the
    // restart code is sufficient on every platform.
    if (!isManagedRestart()) {
        console.warn(`No launcher or supervisor detected; the process will exit with code ${RESTART_EXIT_CODE} and must be restarted by its service manager.`);
    }

    response.once('finish', () => {
        setTimeout(() => {
            console.info(`Restart requested; exiting with code ${RESTART_EXIT_CODE} for relaunch.`);
            requestGracefulExit(RESTART_EXIT_CODE);
        }, RESTART_RESPONSE_DELAY_MS);
    });
}

function scheduleZipUpdate(response, stagedUpdate) {
    const helperScriptPath = path.join(serverDirectory, 'src', 'zip-update-helper.js');
    const helper = spawn(process.argv[0], [helperScriptPath, getZipUpdatePayload(stagedUpdate)], {
        cwd: serverDirectory,
        detached: true,
        stdio: process.platform === 'win32' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
        env: process.env,
        windowsHide: false,
    });

    helper.once('error', (error) => {
        console.error('Failed to start ZIP update helper.', error);
    });
    helper.unref();

    response.once('finish', () => {
        setTimeout(() => {
            console.info('ZIP update staged; initiating graceful shutdown so the helper can replace files safely.');
            requestGracefulExit(0);
        }, RESTART_RESPONSE_DELAY_MS);
    });
}

async function restoreAutoStash(git, { reason = 'after update failure' } = {}) {
    try {
        await git.stash(['pop']);
        console.info(`Auto-stashed changes restored ${reason}.`);
        return null;
    } catch (error) {
        const warning = `Auto-stashed changes could not be restored ${reason}: ${error.message}. Your changes remain in git stash.`;
        console.warn(warning);
        return warning;
    }
}

async function restoreGeneratedInstallFileChanges(git, gitStatus) {
    const generatedPaths = getGeneratedInstallChangePaths(gitStatus?.files);

    if (!generatedPaths.length) {
        return gitStatus;
    }

    try {
        await git.raw(['restore', '--staged', '--worktree', '--', ...generatedPaths]);
    } catch {
        await git.raw(['reset', 'HEAD', '--', ...generatedPaths]);
        await git.raw(['checkout', '--', ...generatedPaths]);
    }

    // SillyBunny: Windows launchers can rewrite install metadata while recovering from stale Bun locks.
    console.info(`Restored generated install file changes before checking for updates: ${generatedPaths.join(', ')}.`);

    return await git.status();
}

async function runCommand(command, args, options = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: serverDirectory,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            ...options,
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', chunk => {
            stdout += String(chunk);
        });

        child.stderr?.on('data', chunk => {
            stderr += String(chunk);
        });

        child.once('error', reject);
        child.once('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }

            const output = truncateOutput(stderr || stdout || `Command failed with exit code ${code}.`);
            const error = new Error(output);
            error.code = code;
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
        });
    });
}

function getInstallCommand() {
    const bunLockPath = path.join(serverDirectory, 'bun.lock');
    const packageLockPath = path.join(serverDirectory, 'package-lock.json');
    const preferNodeInstall = isNativeTermuxEnvironment() && !isBunRuntime();

    if (!preferNodeInstall && (isBunRuntime() || fs.existsSync(bunLockPath)) && commandExistsSync('bun')) {
        return {
            command: 'bun',
            args: ['install'],
        };
    }

    if (fs.existsSync(packageLockPath) && commandExistsSync('npm')) {
        return {
            command: 'npm',
            args: ['ci', '--no-audit', '--no-fund', '--omit=dev'],
        };
    }

    return null;
}

async function getRepositoryStatus() {
    const status = {
        supported: false,
        isRepo: false,
        branch: '',
        trackingBranch: '',
        currentCommit: '',
        remoteCommit: '',
        displayBranch: '',
        ahead: 0,
        behind: 0,
        hasLocalChanges: false,
        changedFiles: [],
        changedFilesCount: 0,
        canUpdate: false,
        message: '',
    };

    if (!commandExistsSync('git')) {
        status.message = 'Git is not available in this environment.';
        return status;
    }

    status.supported = true;

    const git = simpleGit({ baseDir: serverDirectory, ...GIT_OPTIONS });
    const isRepo = await isGitRepository(git);

    if (!isRepo) {
        status.message = NON_GIT_REPOSITORY_MESSAGE;
        return status;
    }

    status.isRepo = true;
    status.branch = toTrimmedString(await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => ''));
    status.currentCommit = toTrimmedString(await git.revparse(['--short', 'HEAD']).catch(() => ''));

    const gitStatus = await restoreGeneratedInstallFileChanges(git, await git.status());
    status.hasLocalChanges = !gitStatus.isClean();
    status.changedFilesCount = gitStatus.files.length;
    status.changedFiles = gitStatus.files.slice(0, 12).map(file => ({
        path: file.path,
        index: file.index,
        workingDir: file.working_dir,
    }));

    const trackingBranch = toTrimmedString(await git.revparse(['--abbrev-ref', '@{u}']).catch(() => ''));
    status.trackingBranch = trackingBranch;
    status.displayBranch = getStatusDisplayBranch(status.branch, trackingBranch);

    if (!trackingBranch) {
        status.message = 'This branch is not tracking an upstream remote.';
        return status;
    }

    await git.fetch();

    const [aheadRaw = '0', behindRaw = '0'] = (await git.raw(['rev-list', '--left-right', '--count', `HEAD...${trackingBranch}`]))
        .trim()
        .split(/\s+/);

    status.ahead = Number(aheadRaw) || 0;
    status.behind = Number(behindRaw) || 0;
    status.remoteCommit = toTrimmedString(await git.revparse(['--short', trackingBranch]).catch(() => ''));
    const autoStashForStatus = getConfigValue('autoStashBeforePull', false, 'boolean');
    status.canUpdate = status.behind > 0 && status.ahead === 0 && (!status.hasLocalChanges || autoStashForStatus);
    status.autoStash = autoStashForStatus;

    if (status.behind > 0 && status.ahead > 0) {
        status.message = 'This branch has diverged from upstream and needs manual Git resolution.';
    } else if (status.hasLocalChanges && !autoStashForStatus) {
        status.message = 'Local changes are present, so auto-update is blocked to protect your work.';
    } else if (status.hasLocalChanges && autoStashForStatus) {
        status.message = `Local changes will be auto-stashed before updating. ${status.behind} upstream commit${status.behind === 1 ? '' : 's'} available.`;
    } else if (status.behind > 0) {
        status.message = `${status.behind} upstream commit${status.behind === 1 ? '' : 's'} available.`;
    } else if (status.ahead > 0) {
        status.message = 'This branch is ahead of upstream, likely because of local bundle patches.';
    } else {
        status.message = 'Already up to date.';
    }

    return status;
}

router.post('/status', requireAdminMiddleware, async (_request, response) => {
    try {
        const version = await getVersion();
        const repository = await getRepositoryStatus();
        const release = repository.isRepo ? null : await getLatestZipReleaseStatus(version.pkgVersion);
        response.json({
            runtime: formatRuntimeLabel(),
            configPath: getConfigFilePath(),
            version,
            repository,
            release,
        });
    } catch (error) {
        console.error('Failed to get server admin status.', error);
        response.status(500).json({ error: error.message || 'Failed to get server status.' });
    }
});

router.post('/config/get', requireAdminMiddleware, async (_request, response) => {
    try {
        const { configPath, stat, content } = readConfigDocument();

        response.json({
            path: configPath,
            content,
            lastModifiedMs: stat.mtimeMs,
        });
    } catch (error) {
        console.error('Failed to read config.yaml.', error);
        response.status(error.status || 500).json({ error: error.message || 'Failed to read config.yaml.' });
    }
});

router.post('/config/save', requireAdminMiddleware, async (request, response) => {
    try {
        const content = String(request.body?.content ?? '');
        const restart = Boolean(request.body?.restart);
        const expectedLastModifiedMs = Number(request.body?.expectedLastModifiedMs);

        if (!content.trim()) {
            return response.status(400).json({ error: 'Config content cannot be empty.' });
        }

        const { configPath, stat } = readConfigDocument();
        ensureExpectedConfigMtime(stat, expectedLastModifiedMs);

        const parsed = yaml.parseDocument(content, { prettyErrors: true });
        if (parsed.errors.length > 0) {
            return response.status(400).json({
                error: parsed.errors.map(error => error.message).join('\n\n'),
            });
        }

        const nextContent = content.endsWith('\n') ? content : `${content}\n`;
        tryWriteFileSync(configPath, nextContent);
        const nextStat = fs.statSync(configPath);

        if (restart) {
            scheduleRestart(response);
            return response.status(202).json({
                ok: true,
                restarting: true,
                path: configPath,
                lastModifiedMs: nextStat.mtimeMs,
                message: 'Config saved. Restarting SillyBunny now.',
            });
        }

        return response.json({
            ok: true,
            restarting: false,
            path: configPath,
            lastModifiedMs: nextStat.mtimeMs,
            message: 'Config saved. Restart the server to apply changes.',
        });
    } catch (error) {
        console.error('Failed to save config.yaml.', error);
        response.status(error.status || 500).json({ error: error.message || 'Failed to save config.yaml.' });
    }
});

router.post('/config/chat-completions/get', requireAdminMiddleware, async (_request, response) => {
    try {
        const { configPath, stat, document } = readConfigDocument();

        response.json({
            path: configPath,
            lastModifiedMs: stat.mtimeMs,
            settings: getChatCompletionConfigState(document),
        });
    } catch (error) {
        console.error('Failed to read chat completions config settings.', error);
        response.status(error.status || 500).json({ error: error.message || 'Failed to read chat completions config settings.' });
    }
});

router.post('/config/chat-completions/save', requireAdminMiddleware, async (request, response) => {
    try {
        const restart = Boolean(request.body?.restart);
        const expectedLastModifiedMs = Number(request.body?.expectedLastModifiedMs);
        const normalizedSettings = normalizeChatCompletionConfigInput(request.body?.settings);
        const { configPath, stat, document } = readConfigDocument();

        ensureExpectedConfigMtime(stat, expectedLastModifiedMs);
        applyChatCompletionConfigState(document, normalizedSettings);

        const nextStat = writeConfigDocument(configPath, document);
        const nextSettings = getChatCompletionConfigState(document);

        if (restart) {
            scheduleRestart(response);
            return response.status(202).json({
                ok: true,
                restarting: true,
                path: configPath,
                lastModifiedMs: nextStat.mtimeMs,
                settings: nextSettings,
                message: 'Chat completion server config saved. Restarting SillyBunny now.',
            });
        }

        return response.json({
            ok: true,
            restarting: false,
            path: configPath,
            lastModifiedMs: nextStat.mtimeMs,
            settings: nextSettings,
            message: 'Chat completion server config saved. Restart the server to apply changes.',
        });
    } catch (error) {
        console.error('Failed to save chat completions config settings.', error);
        response.status(error.status || 500).json({ error: error.message || 'Failed to save chat completions config settings.' });
    }
});

router.post('/config/thumbnail-settings/get', requireAdminMiddleware, async (_request, response) => {
    try {
        const { configPath, stat, document } = readConfigDocument();
        const settings = getThumbnailConfigState(document);
        const mobileSettings = getThumbnailMobileConfigState(document);

        applyThumbnailRuntimeConfig(settings, mobileSettings);

        response.json({
            path: configPath,
            lastModifiedMs: stat.mtimeMs,
            settings,
            mobileSettings,
            runtime: {
                ...getThumbnailRuntimeSettings(),
                dimensions: getThumbnailDimensions(),
            },
            mobileRuntime: {
                ...getThumbnailMobileRuntimeSettings(),
                dimensions: getThumbnailMobileDimensions(),
            },
            recommended: SILLYBUNNY_RECOMMENDED_THUMBNAILS,
            recommendedMobile: SILLYBUNNY_RECOMMENDED_THUMBNAILS_MOBILE,
        });
    } catch (error) {
        console.error('Failed to read thumbnail config settings.', error);
        response.status(error.status || 500).json({ error: error.message || 'Failed to read thumbnail config settings.' });
    }
});

router.post('/config/thumbnail-settings/save', requireAdminMiddleware, async (request, response) => {
    try {
        const clearCache = Boolean(request.body?.clearCache);
        const expectedLastModifiedMs = Number(request.body?.expectedLastModifiedMs);
        const normalizedSettings = normalizeThumbnailSettingsInput(request.body?.settings);
        const normalizedMobileSettings = normalizeThumbnailSettingsInput(request.body?.mobileSettings, { mobile: true });
        const { configPath, stat, document } = readConfigDocument();

        ensureExpectedConfigMtime(stat, expectedLastModifiedMs);
        applyThumbnailConfigState(document, normalizedSettings, normalizedMobileSettings);

        const nextStat = writeConfigDocument(configPath, document);
        applyThumbnailRuntimeConfig(normalizedSettings, normalizedMobileSettings);

        let clearResult = null;
        if (clearCache) {
            clearResult = clearThumbnailCacheForUser(request.user.directories);
        }

        response.json({
            ok: true,
            path: configPath,
            lastModifiedMs: nextStat.mtimeMs,
            settings: normalizedSettings,
            mobileSettings: normalizedMobileSettings,
            cleared: clearResult,
            message: clearResult
                ? `Thumbnail settings saved and ${clearResult.filesDeleted} cached file${clearResult.filesDeleted === 1 ? '' : 's'} cleared.`
                : 'Thumbnail settings saved. New thumbnails will use these values.',
        });
    } catch (error) {
        console.error('Failed to save thumbnail config settings.', error);
        response.status(error.status || 500).json({ error: error.message || 'Failed to save thumbnail config settings.' });
    }
});

router.post('/thumbnails/clear-cache', requireAdminMiddleware, async (request, response) => {
    try {
        const result = clearThumbnailCacheForUser(request.user.directories);
        response.json({
            ok: true,
            cleared: result,
            message: `Cleared ${result.filesDeleted} cached thumbnail file${result.filesDeleted === 1 ? '' : 's'}.`,
        });
    } catch (error) {
        console.error('Failed to clear thumbnail cache.', error);
        response.status(error.status || 500).json({ error: error.message || 'Failed to clear thumbnail cache.' });
    }
});

router.post('/logs', requireAdminMiddleware, async (request, response) => {
    try {
        const limit = normalizeInteger(request.body?.limit, { min: 50, max: 600, fallback: 250 });
        const afterId = normalizeInteger(request.body?.afterId, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });

        response.json(getServerLogSnapshot({ limit, afterId }));
    } catch (error) {
        console.error('Failed to read server console logs.', error);
        response.status(500).json({ error: error.message || 'Failed to read server console logs.' });
    }
});

router.post('/restart', requireAdminMiddleware, async (_request, response) => {
    try {
        scheduleRestart(response);
        response.status(202).json({
            ok: true,
            restarting: true,
            serverBootId: getServerBootId(),
            message: `${APP_NAME} is restarting.`,
        });
    } catch (error) {
        console.error('Failed to restart server.', error);
        response.status(500).json({ error: error.message || 'Failed to restart server.' });
    }
});

router.post('/zip-update', requireAdminMiddleware, async (_request, response) => {
    let stagedUpdate = null;

    try {
        const version = await getVersion();
        const repository = await getRepositoryStatus();

        if (repository.isRepo) {
            return response.status(400).json({ error: 'This install is a Git checkout. Use the Git update path instead.', repository });
        }

        const release = await getLatestZipReleaseStatus(version.pkgVersion);

        if (!release.checked) {
            return response.status(502).json({ error: release.message || 'Failed to check GitHub releases.', release });
        }

        if (!release.canUpdate) {
            return response.json({
                updated: false,
                restarting: false,
                message: release.message || 'Already up to date.',
                version,
                repository,
                release,
            });
        }

        stagedUpdate = await stageZipReleaseUpdate(release);
        scheduleZipUpdate(response, stagedUpdate);

        response.status(202).json({
            updated: true,
            restarting: true,
            message: `ZIP release v${release.latestVersion} downloaded. Restarting SillyBunny to replace app files safely.`,
            version,
            repository,
            release: {
                ...release,
                staged: true,
            },
        });

        stagedUpdate = null;
    } catch (error) {
        if (stagedUpdate?.stagingRoot) {
            fs.rmSync(stagedUpdate.stagingRoot, { recursive: true, force: true });
        }
        console.error('Failed to start ZIP update.', error);
        response.status(500).json({ error: error.message || 'Failed to start ZIP update.' });
    }
});

router.post('/update', requireAdminMiddleware, async (_request, response) => {
    let git = null;
    let stashed = false;
    try {
        const repository = await getRepositoryStatus();

        if (!repository.supported) {
            return response.status(400).json({ error: repository.message || 'Git updates are unavailable in this environment.' });
        }

        if (!repository.isRepo) {
            return response.status(400).json({ error: repository.message || NON_GIT_REPOSITORY_MESSAGE });
        }

        if (!repository.trackingBranch) {
            return response.status(409).json({ error: repository.message || 'This branch is not tracking an upstream remote.', repository });
        }

        const autoStash = getConfigValue('autoStashBeforePull', false, 'boolean');
        git = simpleGit({ baseDir: serverDirectory, ...GIT_OPTIONS });
        let stashPopWarning = null;

        if (repository.hasLocalChanges) {
            if (!autoStash) {
                return response.status(409).json({ error: repository.message || 'Local changes are present, so auto-update is blocked.', repository });
            }
            try {
                await git.stash(['push', '-u', '-m', 'SillyBunny auto-stash before update']);
                stashed = true;
                console.info('Local changes, including untracked files, stashed before update.');
            } catch (stashError) {
                console.error('Failed to stash local changes.', stashError);
                return response.status(500).json({ error: 'Failed to stash local changes: ' + stashError.message });
            }
        }

        if (repository.ahead > 0 && repository.behind > 0) {
            if (stashed) {
                stashPopWarning = await restoreAutoStash(git, { reason: 'after diverged-branch update stop' });
            }
            return response.status(409).json({ error: repository.message || 'This branch has diverged from upstream.', repository, stashed, stashPopWarning });
        }

        if (repository.behind === 0) {
            if (stashed) {
                stashPopWarning = await restoreAutoStash(git, { reason: 'after no-op update' });
            }
            return response.json({
                updated: false,
                restarting: false,
                stashed,
                stashPopWarning,
                message: `Already up to date on ${repository.branch || 'current branch'} tracking ${repository.trackingBranch}.`,
                repository,
            });
        }

        await git.fetch();
        await git.raw(['merge', '--ff-only', repository.trackingBranch]);

        if (stashed) {
            stashPopWarning = await restoreAutoStash(git, { reason: 'after update' });
        }

        const installCommand = getInstallCommand();
        let installResult = null;
        let restorePackageLockAfterInstall = false;

        if (installCommand) {
            restorePackageLockAfterInstall = installCommand.command === 'npm'
                && installCommand.args.includes('ci')
                && commandExistsSync('git')
                && fs.existsSync(path.join(serverDirectory, 'package-lock.json'));
            installResult = await runCommand(installCommand.command, installCommand.args);

            if (restorePackageLockAfterInstall) {
                await runCommand('git', ['restore', '--', 'package-lock.json']).catch(() => null);
            }
        }

        const nextRepository = await getRepositoryStatus();
        const nextVersion = await getVersion();

        scheduleRestart(response);

        response.status(202).json({
            updated: true,
            restarting: true,
            stashed,
            stashPopWarning,
            message: stashPopWarning || `Update applied from ${repository.trackingBranch}. Restarting SillyBunny now.`,
            version: nextVersion,
            repository: nextRepository,
            install: installResult ? {
                command: [installCommand.command, ...installCommand.args].join(' '),
                stdout: truncateOutput(installResult.stdout),
                stderr: truncateOutput(installResult.stderr),
            } : null,
        });
    } catch (error) {
        console.error('Failed to update SillyBunny.', error);
        let stashPopWarning = null;
        if (stashed && git) {
            stashPopWarning = await restoreAutoStash(git, { reason: 'after update failure' });
        }
        response.status(500).json({
            error: error.message || 'Failed to update SillyBunny.',
            stashed,
            stashPopWarning,
        });
    }
});

router.post('/branches', requireAdminMiddleware, async (_request, response) => {
    try {
        if (!commandExistsSync('git')) {
            return response.status(400).json({ error: 'Git is not available in this environment.' });
        }

        const git = simpleGit({ baseDir: serverDirectory, ...GIT_OPTIONS });
        const isRepo = await isGitRepository(git);

        if (!isRepo) {
            return response.status(400).json({ error: NON_GIT_REPOSITORY_MESSAGE });
        }

        // Get current branch
        const currentBranch = toTrimmedString(await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => ''));
        const trackingBranch = toTrimmedString(await git.revparse(['--abbrev-ref', '@{u}']).catch(() => ''));
        const displayBranch = getStatusDisplayBranch(currentBranch, trackingBranch);

        // Get all remote branches
        await git.fetch(['--all', '--prune']);
        const branchSummary = await git.branch(['-r']);
        const branches = getBranchDisplayNames(getRemoteBranchesFromSummary(branchSummary));

        response.json({
            currentBranch,
            displayBranch,
            branches,
        });
    } catch (error) {
        console.error('Failed to list branches.', error);
        response.status(500).json({ error: error.message || 'Failed to list branches.' });
    }
});

router.post('/switch-branch', requireAdminMiddleware, async (request, response) => {
    try {
        const branch = String(request.body?.branch ?? '').trim();
        const autoStash = Boolean(request.body?.autoStash);

        if (!branch) {
            return response.status(400).json({ error: 'Branch name is required.' });
        }

        if (!commandExistsSync('git')) {
            return response.status(400).json({ error: 'Git is not available in this environment.' });
        }

        const git = simpleGit({ baseDir: serverDirectory, ...GIT_OPTIONS });
        const isRepo = await isGitRepository(git);

        if (!isRepo) {
            return response.status(400).json({ error: NON_GIT_REPOSITORY_MESSAGE });
        }

        // Check for local changes
        const gitStatus = await git.status();
        const hasLocalChanges = !gitStatus.isClean();

        if (hasLocalChanges && !autoStash) {
            return response.status(400).json({
                error: 'You have local changes. Enable auto-stash or commit/discard your changes first.',
                hasLocalChanges: true,
                changedFiles: gitStatus.files.slice(0, 10).map(f => f.path),
            });
        }

        // Stash if needed
        if (hasLocalChanges && autoStash) {
            await git.stash(['push', '-u', '-m', `Auto-stash before switching to ${branch}`]);
        }

        let branchSummary = await git.branch(['-r']);
        let remoteBranches = getRemoteBranchesFromSummary(branchSummary);
        let remoteBranch = resolveRemoteBranchName(remoteBranches, branch);

        if (!remoteBranch) {
            await git.fetch(['--all', '--prune']);
            branchSummary = await git.branch(['-r']);
            remoteBranches = getRemoteBranchesFromSummary(branchSummary);
            remoteBranch = resolveRemoteBranchName(remoteBranches, branch);
        }

        const currentBranch = toTrimmedString(await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => ''));

        if (remoteBranch && isRuntimeBranch(currentBranch)) {
            await git.raw(['checkout', '-B', currentBranch, remoteBranch]);
            await git.raw(['branch', `--set-upstream-to=${remoteBranch}`, currentBranch]);
        } else {
            await git.checkout(branch);
        }

        // Try to pop stash if we stashed
        let stashRestored = false;
        if (hasLocalChanges && autoStash) {
            try {
                await git.stash(['pop']);
                stashRestored = true;
            } catch (stashError) {
                console.warn('Failed to restore stash after branch switch:', stashError);
            }
        }

        // Schedule restart
        scheduleRestart(response);

        response.status(202).json({
            ok: true,
            branch,
            stashed: hasLocalChanges && autoStash,
            stashRestored,
            restarting: true,
            message: `Switched to branch "${branch}". Restarting SillyBunny now.`,
        });
    } catch (error) {
        console.error('Failed to switch branch.', error);
        response.status(500).json({ error: error.message || 'Failed to switch branch.' });
    }
});
