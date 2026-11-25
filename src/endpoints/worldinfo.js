import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { tryParse, tryWriteFileSync } from '../util.js';
import { localizeWorldInfoExternalMedia } from '../external-media-import.js';
import { restoreExternalMediaUrls } from '../external-media-manifest.js';

const WORLD_INFO_EXTENSION = '.json';
// SillyBunny divergence: canonical World Info filenames are UTF-8 bounded and written through the fork's safe persistence path.
const MAX_FILENAME_BYTES = 255;
const ATOMIC_WRITE_SUFFIX_BYTES = 16;

function truncateUtf8(value, maxBytes) {
    let result = '';
    let bytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character);
        if (bytes + characterBytes > maxBytes) {
            break;
        }
        result += character;
        bytes += characterBytes;
    }
    return result;
}

/**
 * Gets the canonical filename for a World Info name.
 * @param {string} name World Info name
 * @returns {string} Canonical JSON filename
 */
export function getWorldInfoFilename(name) {
    const worldName = getWorldInfoName(name);
    return worldName ? `${worldName}${WORLD_INFO_EXTENSION}` : '';
}

/**
 * Gets the canonical persisted name for a World Info name.
 * @param {string} name World Info name
 * @returns {string} Canonical World Info name
 */
export function getWorldInfoName(name) {
    const sanitizedName = sanitize(String(name ?? ''));
    return truncateUtf8(sanitizedName, MAX_FILENAME_BYTES - Buffer.byteLength(WORLD_INFO_EXTENSION) - ATOMIC_WRITE_SUFFIX_BYTES);
}

function getLegacyWorldInfoFilename(name) {
    return sanitize(`${String(name ?? '')}${WORLD_INFO_EXTENSION}`);
}

function getExistingWorldInfoFilename(directories, name) {
    const legacyFilename = getLegacyWorldInfoFilename(name);
    if (legacyFilename && fs.existsSync(path.join(directories.worlds, legacyFilename))) {
        return legacyFilename;
    }

    const canonicalFilename = getWorldInfoFilename(name);
    if (canonicalFilename && fs.existsSync(path.join(directories.worlds, canonicalFilename))) {
        return canonicalFilename;
    }

    return null;
}

function writeWorldInfoFile(filePath, data) {
    const canUseAtomicSuffix = Buffer.byteLength(path.basename(filePath)) + ATOMIC_WRITE_SUFFIX_BYTES <= MAX_FILENAME_BYTES;
    if (canUseAtomicSuffix) {
        tryWriteFileSync(filePath, data);
        return;
    }

    const tempDirectory = fs.mkdtempSync(path.join(path.dirname(filePath), '.wi-write-'));
    const tempPath = path.join(tempDirectory, 'new');
    const backupPath = path.join(tempDirectory, 'old');
    let preserveTempDirectory = false;
    try {
        fs.writeFileSync(tempPath, data, 'utf8');
        try {
            fs.renameSync(tempPath, filePath);
        } catch (error) {
            if (!fs.existsSync(filePath)) {
                throw error;
            }
            fs.renameSync(filePath, backupPath);
            try {
                fs.renameSync(tempPath, filePath);
            } catch (replacementError) {
                try {
                    fs.renameSync(backupPath, filePath);
                } catch (rollbackError) {
                    preserveTempDirectory = true;
                    throw new AggregateError([replacementError, rollbackError], `Failed to replace or restore ${filePath}`);
                }
                throw replacementError;
            }
        }
    } finally {
        if (!preserveTempDirectory) {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        }
    }
}

/**
 * Validates the minimum native World Info shape required by the editor and scanner.
 * @param {unknown} data World Info data
 * @returns {boolean} Whether the data has a usable entries object
 */
export function isValidWorldInfoData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }

    const entries = data.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return false;
    }

    return Object.values(entries).every(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
}

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = getExistingWorldInfoFilename(directories, worldInfoName);
    if (!filename) {
        console.error(`World info file ${getWorldInfoFilename(worldInfoName)} doesn't exist.`);
        return dummyObject;
    }
    const pathToWorldInfo = path.join(directories.worlds, filename);

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

export const router = express.Router();

// SillyBunny: the list only needs each book's name and extensions, so those are kept per file and
// reused while (mtimeMs, size) is unchanged. Each listing rebuilds the folder's map, dropping deleted files.
/** @type {Map<string, Map<string, {mtimeMs: number, size: number, name: unknown, extensions: object}>>} */
const worldInfoListCache = new Map();
const WORLD_INFO_LIST_CONCURRENCY = 16;

// SillyBunny: a file's JSON is validated once per (mtimeMs, size); unchanged files are sent as stored.
/** @type {Map<string, {mtimeMs: number, size: number}>} */
const validatedWorldInfoFiles = new Map();
const VALIDATED_WORLD_INFO_LIMIT = 256;

export function clearWorldInfoCaches() {
    worldInfoListCache.clear();
    validatedWorldInfoFiles.clear();
}

function invalidateWorldInfoFileCaches(filePath) {
    validatedWorldInfoFiles.delete(filePath);
    worldInfoListCache.get(path.dirname(filePath))?.delete(filePath);
}

/**
 * Reads the list entry for one World Info file, from cache when the file is unchanged.
 * @param {string} filePath Full path to the file
 * @param {Map<string, {mtimeMs: number, size: number, name: unknown, extensions: object}>} previous Entries from the last listing
 * @param {Map<string, {mtimeMs: number, size: number, name: unknown, extensions: object}>} next Entries for this listing
 * @returns {Promise<{name: unknown, extensions: object}>} Header fields for the list
 */
async function readWorldInfoListHeader(filePath, previous, next) {
    const stats = await fs.promises.stat(filePath);
    const cached = previous.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        next.set(filePath, cached);
        return cached;
    }

    const fileContents = await fs.promises.readFile(filePath, 'utf8');
    const fileContentsParsed = tryParse(fileContents) || {};
    const fileExtensions = fileContentsParsed?.extensions || {};
    const header = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        name: fileContentsParsed?.name,
        extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
    };
    next.set(filePath, header);
    return header;
}

router.post('/list', async (request, response) => {
    try {
        const worldsDirectory = request.user.directories.worlds;
        const jsonFiles = (await fs.promises.readdir(worldsDirectory, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        const previous = worldInfoListCache.get(worldsDirectory) ?? new Map();
        const next = new Map();
        /** @type {Array<{file_id: string, name: unknown, extensions: object}|null>} */
        const slots = new Array(jsonFiles.length).fill(null);

        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < jsonFiles.length) {
                const position = nextIndex++;
                const file = jsonFiles[position];
                try {
                    const filePath = path.join(worldsDirectory, file.name);
                    const header = await readWorldInfoListHeader(filePath, previous, next);
                    const fileNameWithoutExt = path.parse(file.name).name;
                    slots[position] = {
                        file_id: fileNameWithoutExt,
                        name: header.name || fileNameWithoutExt,
                        extensions: header.extensions,
                    };
                } catch (err) {
                    console.warn(`Error reading or parsing World Info file ${file.name}:`, err);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(WORLD_INFO_LIST_CONCURRENCY, jsonFiles.length) }, worker));
        worldInfoListCache.set(worldsDirectory, next);

        return response.send(slots.filter(Boolean));
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', async (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    try {
        const worldInfoName = request.body.name;
        const filename = getExistingWorldInfoFilename(request.user.directories, worldInfoName);
        if (!filename) {
            console.error(`World info file ${getWorldInfoFilename(worldInfoName)} doesn't exist.`);
            return response.sendStatus(404);
        }

        // SillyBunny: send the stored JSON text instead of parsing and re-serializing it. The body
        // decodes to the same value; only insignificant whitespace differs.
        const pathToWorldInfo = path.join(request.user.directories.worlds, filename);
        const fileHandle = await fs.promises.open(pathToWorldInfo, 'r');
        let stats;
        let worldInfoText;
        try {
            stats = await fileHandle.stat();
            worldInfoText = await fileHandle.readFile('utf8');
        } finally {
            await fileHandle.close();
        }

        const validated = validatedWorldInfoFiles.get(pathToWorldInfo);
        if (validated && validated.mtimeMs === stats.mtimeMs && validated.size === stats.size) {
            validatedWorldInfoFiles.delete(pathToWorldInfo);
        } else {
            const parsed = JSON.parse(worldInfoText);
            if (!parsed) {
                // Matches the old falsy-file branch: a stored falsy JSON value reads as a missing book.
                return response.sendStatus(404);
            }
        }
        validatedWorldInfoFiles.set(pathToWorldInfo, { mtimeMs: stats.mtimeMs, size: stats.size });
        if (validatedWorldInfoFiles.size > VALIDATED_WORLD_INFO_LIMIT) {
            validatedWorldInfoFiles.delete(validatedWorldInfoFiles.keys().next().value);
        }

        return response.type('json').send(worldInfoText);
    } catch (err) {
        console.error('Failed to read World Info file:', err);
        return response.sendStatus(500);
    }
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const filename = getExistingWorldInfoFilename(request.user.directories, worldInfoName);
    if (!filename) {
        return response.sendStatus(404);
    }
    const pathToWorldInfo = path.join(request.user.directories.worlds, filename);

    fs.unlinkSync(pathToWorldInfo);
    invalidateWorldInfoFileCaches(pathToWorldInfo);

    return response.sendStatus(200);
});

// SillyBunny: async, because the import waits for the optional external media download.
router.post('/import', async (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const pathToUpload = path.join(request.file.destination, request.file.filename);

    try {
        const requestedName = request.body.name ?? path.parse(request.file.originalname).name;
        const filename = getExistingWorldInfoFilename(request.user.directories, requestedName)
            ?? getWorldInfoFilename(requestedName);
        if (!filename) {
            return response.status(400).send('World file must have a name');
        }

        const fileContents = request.body.convertedData ?? fs.readFileSync(pathToUpload, 'utf8');
        const worldContent = tryParse(fileContents);
        if (!isValidWorldInfoData(worldContent)) {
            console.warn(`World Info import rejected: '${requestedName}' is not a valid world info file`);
            return response.status(400).send('Is not a valid world info file');
        }

        const worldName = path.parse(filename).name;
        // SillyBunny: optionally download external media on import and rewrite URLs to local paths.
        const localized = await localizeWorldInfoExternalMedia(worldContent, { request, worldName });
        const persistedContents = localized.changed ? JSON.stringify(worldContent, null, 4) : fileContents;

        const pathToNewFile = path.join(request.user.directories.worlds, filename);
        writeWorldInfoFile(pathToNewFile, persistedContents);
        invalidateWorldInfoFileCaches(pathToNewFile);
        return response.send(localized.changed ? { name: worldName, data: worldContent } : { name: worldName });
    } catch (err) {
        console.error('World Info import failed:', err);
        return response.sendStatus(500);
    } finally {
        fs.rmSync(pathToUpload, { force: true });
    }
});

// SillyBunny: the editor builds a lorebook export in the browser, so it asks here for the copy with the author's URLs back for the media that an import stored.
router.post('/export', (request, response) => {
    const data = request.body?.data;
    if (!isValidWorldInfoData(data)) {
        return response.status(400).send('Is not a valid world info file');
    }

    restoreExternalMediaUrls(data, request.user.directories);
    return response.type('json').send(JSON.stringify(data));
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!isValidWorldInfoData(request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const filename = getExistingWorldInfoFilename(request.user.directories, request.body.name)
        ?? getWorldInfoFilename(request.body.name);
    const pathToFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(filename).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    writeWorldInfoFile(pathToFile, JSON.stringify(request.body.data, null, 4));
    invalidateWorldInfoFileCaches(pathToFile);

    return response.send({ ok: true, name: worldName });
});

router.post('/rename', (request, response) => {
    const { oldName, newName, data } = request.body ?? {};
    if (!oldName || !newName || !isValidWorldInfoData(data)) {
        return response.sendStatus(400);
    }

    const oldFilename = getExistingWorldInfoFilename(request.user.directories, oldName);
    const newFilename = getWorldInfoFilename(newName);
    const canonicalName = getWorldInfoName(newName);
    if (!oldFilename || !newFilename || getWorldInfoName(oldName) === canonicalName) {
        return response.status(400).send('World file must have a different name');
    }

    const oldPath = path.join(request.user.directories.worlds, oldFilename);
    const newPath = path.join(request.user.directories.worlds, newFilename);
    const existingTargetFilename = getExistingWorldInfoFilename(request.user.directories, newName);
    if (existingTargetFilename || fs.existsSync(newPath)) {
        return response.sendStatus(409);
    }

    try {
        writeWorldInfoFile(oldPath, JSON.stringify(data, null, 4));
        fs.renameSync(oldPath, newPath);
        invalidateWorldInfoFileCaches(oldPath);
        invalidateWorldInfoFileCaches(newPath);
        return response.send({ ok: true, name: canonicalName });
    } catch (err) {
        console.error('World Info rename failed:', err);
        return response.sendStatus(500);
    }
});
