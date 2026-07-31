import fs from 'node:fs';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import storage from 'node-persist';
import express from 'express';
import yauzl from 'yauzl';

import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, createBackupArchive, ensurePublicDirectoriesExist, toAvatarKey, getAccountVersion } from '../users.js';
import { SETTINGS_FILE, USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { SECRETS_FILE } from './secrets.js';
import { color, Cache, getConfigValue, ensureDirectory, normalizeZipEntryPath } from '../util.js';
import { ENTITY_DATE_ADDED_FILE, importEntityDateAdded } from '../entity-date-added.js';
import { ENTITY_LAST_CHAT_FILE, importEntityLastChat } from '../entity-last-chat.js';

// SillyBunny divergence: private user export/import keeps fork-owned account data and metadata compatible across releases.
const RESET_CACHE = new Cache(5 * 60 * 1000);
const IMPORTABLE_ROOT_FILES = [SETTINGS_FILE, SECRETS_FILE, ENTITY_DATE_ADDED_FILE, ENTITY_LAST_CHAT_FILE];
const IMPORTABLE_TOP_LEVEL_DIRECTORIES = [...new Set(
    Object.values(USER_DIRECTORY_TEMPLATE)
        .filter(Boolean)
        .map(relativePath => String(relativePath).split('/')[0])
        .filter(Boolean),
)];
const IMPORTABLE_RELATIVE_PATHS = [...new Set([...IMPORTABLE_ROOT_FILES, ...IMPORTABLE_TOP_LEVEL_DIRECTORIES])];
const LIKELY_IMPORT_MARKERS = [
    SETTINGS_FILE,
    'characters',
    'chats',
    'group chats',
    'groups',
    'OpenAI Settings',
    'themes',
    'extensions',
];
const SKIPPABLE_IMPORT_DIRECTORY_NAMES = new Set(['.git']);

export const router = express.Router();

function isImportableRelativePath(relativePath) {
    const normalizedPath = normalizeZipEntryPath(relativePath);
    if (!normalizedPath || normalizedPath.startsWith('__MACOSX/')) {
        return false;
    }

    return IMPORTABLE_RELATIVE_PATHS.some(basePath => (
        normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`)
    ));
}

async function pathExists(targetPath) {
    try {
        await fsPromises.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function isLikelyUserImportDirectory(directoryPath) {
    for (const marker of LIKELY_IMPORT_MARKERS) {
        if (await pathExists(path.join(directoryPath, marker))) {
            return true;
        }
    }

    return false;
}

async function findUserImportRootsInDataDirectory(dataDirectory) {
    const dirents = await fsPromises.readdir(dataDirectory, { withFileTypes: true });
    const candidates = [];

    for (const dirent of dirents) {
        if (!dirent.isDirectory()) {
            continue;
        }

        const candidatePath = path.join(dataDirectory, dirent.name);
        if (await isLikelyUserImportDirectory(candidatePath)) {
            candidates.push(candidatePath);
        }
    }

    return candidates;
}

async function resolveSillyTavernFolderImportRoot(inputPath) {
    const normalizedInput = String(inputPath ?? '').trim();
    if (!normalizedInput) {
        throw new Error('A SillyTavern folder path is required.');
    }

    const resolvedPath = path.resolve(normalizedInput);
    const stats = await fsPromises.stat(resolvedPath).catch(() => null);

    if (!stats?.isDirectory()) {
        throw new Error('That SillyTavern path does not exist or is not a folder.');
    }

    if (await isLikelyUserImportDirectory(resolvedPath)) {
        return resolvedPath;
    }

    const dataDirectory = path.basename(resolvedPath) === 'data'
        ? resolvedPath
        : path.join(resolvedPath, 'data');

    if (!(await pathExists(dataDirectory))) {
        throw new Error('No SillyTavern user data was found there. Point to the app folder, its data folder, or a specific user folder.');
    }

    const candidates = await findUserImportRootsInDataDirectory(dataDirectory);
    if (candidates.length === 0) {
        throw new Error('No importable SillyTavern user folder was found there.');
    }

    if (candidates.length === 1) {
        return candidates[0];
    }

    const defaultUserCandidate = candidates.find(candidate => path.basename(candidate) === 'default-user');
    if (defaultUserCandidate) {
        return defaultUserCandidate;
    }

    throw new Error('Multiple SillyTavern user folders were found. Please point to the exact user folder you want to import.');
}

function isSameOrNestedPath(candidatePath, parentPath) {
    const relativePath = path.relative(parentPath, candidatePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function getStableRealPath(targetPath) {
    try {
        return await fsPromises.realpath(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

function emitImportWarning(onWarning, message) {
    const warningMessage = String(message ?? '').trim();
    if (!warningMessage) {
        return;
    }

    if (typeof onWarning === 'function') {
        onWarning(warningMessage);
        return;
    }

    console.warn(warningMessage);
}

async function copyDirectoryTree(sourceDirectory, destinationDirectory, {
    overwrite = false,
    protectedRoots = new Set(),
    visitedDirectories = new Set(),
    skipDirectoryNames = new Set(),
    onWarning = null,
} = {}) {
    const stableSourcePath = await getStableRealPath(sourceDirectory);

    if (visitedDirectories.has(stableSourcePath)) {
        emitImportWarning(onWarning, `Skipping already-visited import directory: ${sourceDirectory}`);
        return 0;
    }

    for (const protectedRoot of protectedRoots) {
        if (isSameOrNestedPath(stableSourcePath, protectedRoot)) {
            emitImportWarning(onWarning, `Skipping import path that resolves into the current account: ${sourceDirectory}`);
            return 0;
        }
    }

    visitedDirectories.add(stableSourcePath);
    await fsPromises.mkdir(destinationDirectory, { recursive: true });

    let copiedFiles = 0;
    const dirents = await fsPromises.readdir(sourceDirectory, { withFileTypes: true });

    for (const dirent of dirents) {
        const sourcePath = path.join(sourceDirectory, dirent.name);
        const destinationPath = path.join(destinationDirectory, dirent.name);

        if (dirent.isSymbolicLink()) {
            emitImportWarning(onWarning, `Skipping symbolic link during SillyTavern import: ${sourcePath}`);
            continue;
        }

        if (dirent.isDirectory()) {
            if (skipDirectoryNames.has(dirent.name)) {
                emitImportWarning(onWarning, `Skipping ${dirent.name} metadata during SillyTavern import: ${sourcePath}`);
                continue;
            }

            copiedFiles += await copyDirectoryTree(sourcePath, destinationPath, {
                overwrite,
                protectedRoots,
                visitedDirectories,
                skipDirectoryNames,
                onWarning,
            });
            continue;
        }

        if (!dirent.isFile()) {
            emitImportWarning(onWarning, `Skipping unsupported import entry: ${sourcePath}`);
            continue;
        }

        if (!overwrite && await pathExists(destinationPath)) {
            continue;
        }

        ensureDirectory(path.dirname(destinationPath));
        await fsPromises.copyFile(sourcePath, destinationPath);
        copiedFiles++;
    }

    return copiedFiles;
}

async function copyAllowedFolderContents(sourceRoot, targetRoot) {
    let copiedEntries = 0;
    let importedEntityDateAdded;
    let importedEntityLastChat;
    const protectedRoots = new Set([await getStableRealPath(targetRoot)]);
    const visitedDirectories = new Set();

    for (const relativePath of IMPORTABLE_RELATIVE_PATHS) {
        const sourcePath = path.join(sourceRoot, relativePath);
        if (!(await pathExists(sourcePath))) {
            continue;
        }

        const destinationPath = path.join(targetRoot, relativePath);
        const stats = await fsPromises.stat(sourcePath);

        if (relativePath === ENTITY_DATE_ADDED_FILE && stats.isFile()) {
            importedEntityDateAdded = await fsPromises.readFile(sourcePath);
            continue;
        }

        if (relativePath === ENTITY_LAST_CHAT_FILE && stats.isFile()) {
            importedEntityLastChat = await fsPromises.readFile(sourcePath);
            continue;
        }

        if (stats.isDirectory()) {
            const copiedFiles = await copyDirectoryTree(sourcePath, destinationPath, {
                overwrite: true,
                protectedRoots,
                visitedDirectories,
                skipDirectoryNames: relativePath === USER_DIRECTORY_TEMPLATE.extensions
                    ? SKIPPABLE_IMPORT_DIRECTORY_NAMES
                    : new Set(),
                onWarning: warning => console.warn(warning),
            });
            if (copiedFiles > 0 || await pathExists(destinationPath)) {
                copiedEntries++;
            }
            continue;
        }

        ensureDirectory(path.dirname(destinationPath));
        await fsPromises.copyFile(sourcePath, destinationPath);
        copiedEntries++;
    }

    if (importedEntityDateAdded !== undefined) {
        try {
            importEntityDateAdded(targetRoot, importedEntityDateAdded);
            copiedEntries++;
        } catch (error) {
            console.warn('Could not import date-added metadata. Imported entities will be indexed locally.', error);
        }
    }

    if (importedEntityLastChat !== undefined) {
        try {
            importEntityLastChat(targetRoot, importedEntityLastChat);
            copiedEntries++;
        } catch (error) {
            console.warn('Could not import last-chat metadata. Imported characters will fall back to their card value.', error);
        }
    }

    if (copiedEntries === 0) {
        throw new Error('Nothing importable was found in that folder.');
    }

    return copiedEntries;
}

async function inspectExtensionDirectory(extensionPath, extensionName) {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    const details = {
        displayName: extensionName,
        version: '',
        author: '',
        manifestFound: false,
        manifestValid: false,
        jsEntry: '',
        jsEntryExists: false,
        warnings: [],
    };

    if (!(await pathExists(manifestPath))) {
        details.warnings.push('Missing manifest.json. SillyBunny cannot discover this extension until it is restored.');
        return details;
    }

    details.manifestFound = true;

    try {
        const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
        details.manifestValid = true;
        details.displayName = typeof manifest?.display_name === 'string' && manifest.display_name.trim()
            ? manifest.display_name.trim()
            : extensionName;
        details.version = typeof manifest?.version === 'string' ? manifest.version : '';
        details.author = typeof manifest?.author === 'string' ? manifest.author : '';
        details.jsEntry = typeof manifest?.js === 'string' && manifest.js.trim() ? manifest.js.trim() : '';

        if (!details.jsEntry) {
            details.warnings.push('manifest.json is missing a "js" entry, so this extension may not load.');
            return details;
        }

        details.jsEntryExists = await pathExists(path.join(extensionPath, details.jsEntry));
        if (!details.jsEntryExists) {
            details.warnings.push(`The manifest JS entry "${details.jsEntry}" could not be found in the synced files.`);
        }
    } catch (error) {
        details.warnings.push(`manifest.json could not be parsed: ${error.message}`);
    }

    return details;
}

function buildExtensionSyncMessage({ readyCount, warningCount, failedCount }) {
    const parts = [];
    const syncedCount = readyCount + warningCount;

    parts.push(`Synced ${syncedCount} third-party extension${syncedCount === 1 ? '' : 's'}.`);

    if (warningCount > 0) {
        parts.push(`${warningCount} ${warningCount === 1 ? 'needs' : 'need'} attention.`);
    }

    if (failedCount > 0) {
        parts.push(`${failedCount} failed.`);
    }

    parts.push('Review the sync report before reloading.');
    return parts.join(' ');
}

async function syncThirdPartyExtension(sourcePath, targetPath, protectedRoots) {
    const extensionName = path.basename(sourcePath);
    const warnings = [];
    const sourceGitDirectory = path.join(sourcePath, '.git');
    const gitMetadataSkipped = await pathExists(sourceGitDirectory);
    const tempTargetPath = await fsPromises.mkdtemp(path.join(path.dirname(targetPath), `.${extensionName}-sync-`));

    try {
        const copiedFiles = await copyDirectoryTree(sourcePath, tempTargetPath, {
            overwrite: true,
            protectedRoots,
            skipDirectoryNames: SKIPPABLE_IMPORT_DIRECTORY_NAMES,
            onWarning: warning => warnings.push(warning),
        });

        const details = await inspectExtensionDirectory(tempTargetPath, extensionName);
        warnings.push(...details.warnings);

        await fsPromises.rm(targetPath, { recursive: true, force: true });
        await fsPromises.rename(tempTargetPath, targetPath);

        const status = warnings.length > 0 ? 'warning' : 'ready';
        return {
            name: extensionName,
            displayName: details.displayName,
            version: details.version,
            author: details.author,
            sourcePath,
            targetPath,
            status,
            copiedFiles,
            warnings,
            checks: {
                manifestFound: details.manifestFound,
                manifestValid: details.manifestValid,
                jsEntry: details.jsEntry,
                jsEntryExists: details.jsEntryExists,
                gitMetadataSkipped,
            },
        };
    } catch (error) {
        return {
            name: extensionName,
            displayName: extensionName,
            version: '',
            author: '',
            sourcePath,
            targetPath,
            status: 'failed',
            copiedFiles: 0,
            warnings,
            checks: {
                manifestFound: false,
                manifestValid: false,
                jsEntry: '',
                jsEntryExists: false,
                gitMetadataSkipped,
            },
            error: error.message || 'Failed to sync this extension.',
        };
    } finally {
        await fsPromises.rm(tempTargetPath, { recursive: true, force: true }).catch(() => { });
    }
}

async function syncThirdPartyExtensions(sourceRoot, targetExtensionsRoot) {
    const sourceExtensionsRoot = path.join(sourceRoot, USER_DIRECTORY_TEMPLATE.extensions);
    const sourceExtensionsRealPath = await getStableRealPath(sourceExtensionsRoot);
    const targetExtensionsRealPath = await getStableRealPath(targetExtensionsRoot);

    if (sourceExtensionsRealPath === targetExtensionsRealPath) {
        throw new Error('That extensions folder already belongs to the current SillyBunny account.');
    }

    if (!(await pathExists(sourceExtensionsRoot))) {
        throw new Error('No third-party extensions folder was found in that SillyTavern account.');
    }

    await fsPromises.mkdir(targetExtensionsRoot, { recursive: true });

    const dirents = await fsPromises.readdir(sourceExtensionsRoot, { withFileTypes: true });
    const extensionDirectories = dirents
        .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
        .sort((left, right) => left.name.localeCompare(right.name));

    if (extensionDirectories.length === 0) {
        throw new Error('No third-party extensions were found in that SillyTavern account.');
    }

    const protectedRoots = new Set([await getStableRealPath(targetExtensionsRoot)]);
    const results = [];

    for (const dirent of extensionDirectories) {
        const sourcePath = path.join(sourceExtensionsRoot, dirent.name);
        const targetPath = path.join(targetExtensionsRoot, dirent.name);
        const result = await syncThirdPartyExtension(sourcePath, targetPath, protectedRoots);
        results.push(result);

        if (result.status === 'failed') {
            console.error(`Failed to sync third-party extension "${dirent.name}" from ${sourcePath}: ${result.error}`);
            continue;
        }

        if (result.warnings.length > 0) {
            console.warn(`Synced third-party extension "${dirent.name}" with warnings: ${result.warnings.join(' | ')}`);
        } else {
            console.info(`Synced third-party extension "${dirent.name}" from ${sourcePath}`);
        }
    }

    const readyCount = results.filter(result => result.status === 'ready').length;
    const warningCount = results.filter(result => result.status === 'warning').length;
    const failedCount = results.filter(result => result.status === 'failed').length;
    const gitMetadataSkippedCount = results.filter(result => result?.checks?.gitMetadataSkipped === true).length;

    return {
        sourceRoot,
        sourceExtensionsRoot,
        targetExtensionsRoot,
        results,
        readyCount,
        warningCount,
        failedCount,
        gitMetadataSkippedCount,
        message: buildExtensionSyncMessage({ readyCount, warningCount, failedCount }),
    };
}

function isDefaultUserImportBase(basePath) {
    return String(basePath ?? '') === 'default-user' || String(basePath ?? '').endsWith('/default-user');
}

async function detectZipImportBase(zipFilePath) {
    return await new Promise((resolve, reject) => {
        yauzl.open(zipFilePath, { lazyEntries: true }, (error, zipfile) => {
            if (error) {
                reject(error);
                return;
            }

            const baseScores = new Map();

            zipfile.readEntry();
            zipfile.on('entry', entry => {
                const normalizedEntry = normalizeZipEntryPath(entry.fileName);
                if (!normalizedEntry || normalizedEntry.startsWith('__MACOSX/')) {
                    zipfile.readEntry();
                    return;
                }

                const segments = normalizedEntry.split('/').filter(Boolean);
                for (let index = 0; index < segments.length; index++) {
                    const basePath = segments.slice(0, index).join('/');
                    const relativePath = segments.slice(index).join('/');

                    if (!isImportableRelativePath(relativePath)) {
                        continue;
                    }

                    baseScores.set(basePath, (baseScores.get(basePath) ?? 0) + 1);
                }

                zipfile.readEntry();
            });

            zipfile.once('end', () => {
                const rankedBases = [...baseScores.entries()]
                    .filter(([, score]) => score > 0)
                    .sort((left, right) => {
                        if (right[1] !== left[1]) {
                            return right[1] - left[1];
                        }

                        if (isDefaultUserImportBase(right[0]) !== isDefaultUserImportBase(left[0])) {
                            return Number(isDefaultUserImportBase(right[0])) - Number(isDefaultUserImportBase(left[0]));
                        }

                        return right[0].length - left[0].length;
                    });

                if (!rankedBases.length) {
                    reject(new Error('That ZIP does not contain an importable SillyTavern backup.'));
                    return;
                }

                resolve(rankedBases[0][0]);
            });

            zipfile.once('error', reject);
        });
    });
}

async function importZipContents(zipFilePath, targetRoot) {
    const basePath = await detectZipImportBase(zipFilePath);

    return await new Promise((resolve, reject) => {
        yauzl.open(zipFilePath, { lazyEntries: true }, (error, zipfile) => {
            if (error) {
                reject(error);
                return;
            }

            let importedFiles = 0;
            let importedEntityDateAdded;
            let importedEntityLastChat;
            let completed = false;

            const finalize = (finalError = null) => {
                if (completed) {
                    return;
                }

                completed = true;

                const completionError = finalError;
                if (!completionError && importedEntityDateAdded !== undefined) {
                    try {
                        importEntityDateAdded(targetRoot, importedEntityDateAdded);
                    } catch (error) {
                        importedFiles--;
                        console.warn('Could not import date-added metadata. Imported entities will be indexed locally.', error);
                    }
                }

                if (!completionError && importedEntityLastChat !== undefined) {
                    try {
                        importEntityLastChat(targetRoot, importedEntityLastChat);
                    } catch (error) {
                        importedFiles--;
                        console.warn('Could not import last-chat metadata. Imported characters will fall back to their card value.', error);
                    }
                }

                if (completionError) {
                    reject(completionError);
                } else if (importedFiles === 0) {
                    reject(new Error('That ZIP did not contain any importable SillyTavern files.'));
                } else {
                    resolve(importedFiles);
                }
            };

            zipfile.readEntry();
            zipfile.on('entry', entry => {
                const normalizedEntry = normalizeZipEntryPath(entry.fileName);
                if (!normalizedEntry || normalizedEntry.startsWith('__MACOSX/')) {
                    zipfile.readEntry();
                    return;
                }

                const relativePath = basePath
                    ? normalizedEntry.startsWith(`${basePath}/`)
                        ? normalizedEntry.slice(basePath.length + 1)
                        : ''
                    : normalizedEntry;

                if (!relativePath || !isImportableRelativePath(relativePath)) {
                    zipfile.readEntry();
                    return;
                }

                if (entry.fileName.endsWith('/')) {
                    ensureDirectory(path.join(targetRoot, relativePath));
                    zipfile.readEntry();
                    return;
                }

                zipfile.openReadStream(entry, (streamError, readStream) => {
                    if (streamError || !readStream) {
                        finalize(streamError || new Error('Failed to read the backup ZIP.'));
                        return;
                    }

                    const destinationPath = path.join(targetRoot, relativePath);
                    ensureDirectory(path.dirname(destinationPath));

                    if (relativePath === ENTITY_DATE_ADDED_FILE || relativePath === ENTITY_LAST_CHAT_FILE) {
                        const chunks = [];
                        readStream.on('data', chunk => chunks.push(chunk));
                        readStream.once('error', finalize);
                        readStream.once('end', () => {
                            if (relativePath === ENTITY_DATE_ADDED_FILE) {
                                importedEntityDateAdded = Buffer.concat(chunks);
                            } else {
                                importedEntityLastChat = Buffer.concat(chunks);
                            }
                            importedFiles++;
                            zipfile.readEntry();
                        });
                        return;
                    }

                    pipeline(readStream, fs.createWriteStream(destinationPath))
                        .then(() => {
                            importedFiles++;
                            zipfile.readEntry();
                        })
                        .catch(finalize);
                });
            });

            zipfile.once('end', () => finalize());
            zipfile.once('close', () => finalize());
            zipfile.once('error', finalize);
        });
    });
}

router.post('/logout', async (request, response) => {
    try {
        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        request.session.handle = null;
        request.session.csrfToken = null;
        request.session.version = null;
        request.session = null;
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.get('/me', async (request, response) => {
    try {
        if (!request.user) {
            return response.sendStatus(403);
        }

        const user = request.user.profile;
        const viewModel = {
            handle: user.handle,
            name: user.name,
            avatar: await getUserAvatar(user.handle),
            admin: user.admin,
            password: !!user.password,
            created: user.created,
        };

        return response.json(viewModel);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-avatar', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change avatar failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change avatar failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        // Avatar is not a data URL or not an empty string
        if (!request.body.avatar.startsWith('data:image/') && request.body.avatar !== '') {
            console.warn('Change avatar failed: Invalid data URL');
            return response.status(400).json({ error: 'Invalid data URL' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Change avatar failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        await storage.setItem(toAvatarKey(request.body.handle), request.body.avatar);

        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-password', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change password failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change password failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Change password failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.error('Change password failed: User is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (!request.user.profile.admin && user.password && user.password !== getPasswordHash(request.body.oldPassword, user.salt)) {
            console.error('Change password failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
        } else {
            user.password = '';
            user.salt = '';
        }

        await storage.setItem(toKey(request.body.handle), user);

        // Update session version to keep the current session valid after password change
        if (request.session && request.session.handle === user.handle) {
            request.session.version = getAccountVersion(user);
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/backup', async (request, response) => {
    try {
        const allowFullDataBackup = !!getConfigValue('backups.allowFullDataBackup', true, 'boolean');

        if (!allowFullDataBackup) {
            console.warn('Backup failed: Full data backup is disabled in configuration');
            return response.status(403).json({ error: 'Full data backup is disabled' });
        }

        const handle = request.body.handle;

        if (!handle) {
            console.warn('Backup failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Backup failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        await createBackupArchive(handle, response);
    } catch (error) {
        console.error('Backup failed', error);
        return response.sendStatus(500);
    }
});

router.post('/import-sillytavern/folder', async (request, response) => {
    try {
        const sourceRoot = await resolveSillyTavernFolderImportRoot(request.body?.sourcePath);
        const targetRoot = path.resolve(request.user.directories.root);

        if (path.resolve(sourceRoot) === targetRoot) {
            return response.status(400).json({ error: 'That folder is already the current SillyBunny account.' });
        }

        const copiedEntries = await copyAllowedFolderContents(sourceRoot, targetRoot);
        await checkForNewContent([request.user.directories]);

        return response.json({
            message: `Imported ${copiedEntries} data sections from ${sourceRoot}. Reloading is recommended.`,
            sourceRoot,
            copiedEntries,
        });
    } catch (error) {
        console.error('SillyTavern folder import failed:', error);
        return response.status(400).json({ error: error.message || 'Failed to import that SillyTavern folder.' });
    }
});

router.post('/import-sillytavern/extensions', async (request, response) => {
    try {
        const sourceRoot = await resolveSillyTavernFolderImportRoot(request.body?.sourcePath);
        const targetRoot = path.resolve(request.user.directories.root);

        if (path.resolve(sourceRoot) === targetRoot) {
            return response.status(400).json({ error: 'That folder is already the current SillyBunny account.' });
        }

        const syncReport = await syncThirdPartyExtensions(sourceRoot, path.resolve(request.user.directories.extensions));
        await checkForNewContent([request.user.directories]);

        return response.json(syncReport);
    } catch (error) {
        console.error('SillyTavern extension sync failed:', error);
        return response.status(400).json({ error: error.message || 'Failed to sync third-party extensions from that SillyTavern folder.' });
    }
});

router.post('/import-sillytavern/zip', async (request, response) => {
    const uploadedZipPath = request.file?.path;

    try {
        if (!uploadedZipPath) {
            return response.status(400).json({ error: 'A SillyTavern backup ZIP is required.' });
        }

        const importedFiles = await importZipContents(uploadedZipPath, request.user.directories.root);
        await checkForNewContent([request.user.directories]);

        return response.json({
            message: `Imported ${importedFiles} files from the SillyTavern backup ZIP. Reloading is recommended.`,
            importedFiles,
        });
    } catch (error) {
        console.error('SillyTavern ZIP import failed:', error);
        return response.status(400).json({ error: error.message || 'Failed to import that SillyTavern backup ZIP.' });
    } finally {
        if (uploadedZipPath) {
            await fsPromises.rm(uploadedZipPath, { force: true }).catch(() => { });
        }
    }
});

router.post('/reset-settings', async (request, response) => {
    try {
        const password = request.body.password;

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(password, request.user.profile.salt)) {
            console.warn('Reset settings failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        const pathToFile = path.join(request.user.directories.root, SETTINGS_FILE);
        await fsPromises.rm(pathToFile, { force: true });
        await checkForNewContent([request.user.directories], [CONTENT_TYPES.SETTINGS]);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Reset settings failed', error);
        return response.sendStatus(500);
    }
});

router.post('/change-name', async (request, response) => {
    try {
        if (!request.body.name || !request.body.handle) {
            console.warn('Change name failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change name failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.warn('Change name failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.name = request.body.name;
        await storage.setItem(toKey(request.body.handle), user);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Change name failed', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step1', async (request, response) => {
    try {
        const resetCode = String(crypto.randomInt(1000, 9999));
        console.log();
        console.log(color.magenta(`${request.user.profile.name}, your account reset code is: `) + color.red(resetCode));
        console.log();
        RESET_CACHE.set(request.user.profile.handle, resetCode);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    try {
        if (!request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(request.body.password, request.user.profile.salt)) {
            console.warn('Recover step 2 failed: Incorrect password');
            return response.status(400).json({ error: 'Incorrect password' });
        }

        const code = RESET_CACHE.get(request.user.profile.handle);

        if (!code || code !== request.body.code) {
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(400).json({ error: 'Incorrect code' });
        }

        console.info('Resetting account data:', request.user.profile.handle);
        await fsPromises.rm(request.user.directories.root, { recursive: true, force: true });

        await ensurePublicDirectoriesExist();
        await checkForNewContent([request.user.directories]);

        RESET_CACHE.remove(request.user.profile.handle);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});
