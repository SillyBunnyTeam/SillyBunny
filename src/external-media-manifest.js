import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { read as readCharacterCardText } from './character-card-parser.js';

export const EXTERNAL_MEDIA_MANIFEST_FILE = '.external-media.json';

const LOCAL_URL_PREFIX = '/user/images/';
// The folder segment is what `encodeFolderForUrl()` writes and the file segment is a stored file name. The look-behind
// keeps the pattern off a remote URL that happens to contain the same path.
const LOCAL_URL_REGEX = /(?<![\w.~%:/@-])\/user\/images\/([\w%.-]+)\/([\w.-]+)/g;
const MAX_ORIGINAL_URL_LENGTH = 8192;

/** @type {Map<string, Promise<void>>} */
const manifestWrites = new Map();

/**
 * Encodes a folder name for the stored URL. `encodeURIComponent()` keeps `!'()*~`, and a quote or a parenthesis ends
 * the URL early inside a single-quoted attribute, a Markdown image or a CSS `url()`.
 * @param {string} folder Folder name
 * @returns {string} Path segment
 */
export function encodeFolderForUrl(folder) {
    return encodeURIComponent(folder).replace(/[!'()*~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Builds the URL that the import writes into a card or lorebook for a stored file.
 * @param {string} folder Folder name under user/images
 * @param {string} fileName Stored file name
 * @returns {string} Local URL
 */
export function getLocalExternalMediaUrl(folder, fileName) {
    return `${LOCAL_URL_PREFIX}${encodeFolderForUrl(folder)}/${fileName}`;
}

/**
 * Reads the manifest of a media folder. A missing or damaged manifest, and any entry that is not a stored file name
 * with an HTTP(S) URL, gives no mapping, so a bad manifest cannot break the caller.
 * @param {string} folderPath Absolute path of the folder
 * @returns {Map<string, string>} Stored file name to the original URL
 */
export function readExternalMediaManifest(folderPath) {
    /** @type {Map<string, string>} */
    const origins = new Map();
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(folderPath, EXTERNAL_MEDIA_MANIFEST_FILE), 'utf8'));
    } catch {
        return origins;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return origins;
    }
    for (const [fileName, entry] of Object.entries(parsed)) {
        const url = entry?.url;
        if (!/^[\w][\w.-]*$/.test(fileName) || typeof url !== 'string' || url.length > MAX_ORIGINAL_URL_LENGTH || !/^https?:\/\//i.test(url)) {
            continue;
        }
        origins.set(fileName, url);
    }
    return origins;
}

/**
 * Adds stored files and their original URLs to the manifest of a folder. The manifest is read, merged and written
 * again one write at a time per folder, so two imports into one folder keep each other's entries. A file that the
 * manifest already lists keeps its first URL.
 * @param {string} folderPath Absolute path of the folder
 * @param {Map<string, string>} origins Stored file name to the original URL
 * @returns {Promise<void>}
 */
export async function recordExternalMediaOrigins(folderPath, origins) {
    if (origins.size === 0) {
        return;
    }

    const key = path.resolve(folderPath);
    const previous = manifestWrites.get(key) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
        const merged = readExternalMediaManifest(folderPath);
        for (const [fileName, url] of origins) {
            if (!merged.has(fileName)) {
                merged.set(fileName, url);
            }
        }
        const manifest = Object.fromEntries([...merged].map(([fileName, url]) => [fileName, { url }]));
        await writeFileAtomic(path.join(folderPath, EXTERNAL_MEDIA_MANIFEST_FILE), JSON.stringify(manifest, null, 4));
    });
    manifestWrites.set(key, write);
    try {
        await write;
    } finally {
        if (manifestWrites.get(key) === write) {
            manifestWrites.delete(key);
        }
    }
}

/**
 * Resolves the folder segment of a local URL to a folder directly under user/images.
 * @param {string} encodedFolder Folder segment as written into the URL
 * @param {string} userImages Absolute path of user/images
 * @returns {string|null} Folder name, or null when the segment does not name such a folder
 */
function decodeMediaFolder(encodedFolder, userImages) {
    let folder;
    try {
        folder = decodeURIComponent(encodedFolder);
    } catch {
        return null;
    }
    const root = path.resolve(userImages);
    return folder && path.dirname(path.resolve(root, folder)) === root ? folder : null;
}

/**
 * Lists the files of a folder that have one extension.
 * @param {string} directory Folder to list
 * @param {string} extension Lower-case extension with the dot
 * @returns {Promise<string[]>} Absolute file paths, empty when the folder does not exist
 */
async function listFilesWithExtension(directory, extension) {
    try {
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === extension)
            .map(entry => path.join(directory, entry.name));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/**
 * Collects the stored files that the text of the user's character cards and lorebooks names by local URL.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {Promise<Set<string>>} Keys of the form `<folder>/<file name>`
 * @throws {Error} When a card or a lorebook cannot be read
 */
async function collectMediaNamedByCardsAndLorebooks(directories) {
    const named = new Set();
    const noteText = (/** @type {string} */ text) => {
        for (const match of text.matchAll(LOCAL_URL_REGEX)) {
            const folder = decodeMediaFolder(match[1], directories.userImages);
            if (folder) {
                named.add(`${folder}/${match[2].replace(/\.+$/, '')}`);
            }
        }
    };

    for (const cardPath of await listFilesWithExtension(directories.characters, '.png')) {
        noteText(readCharacterCardText(await fs.promises.readFile(cardPath)));
    }
    for (const lorebookPath of await listFilesWithExtension(directories.worlds, '.json')) {
        noteText(await fs.promises.readFile(lorebookPath, 'utf8'));
    }
    return named;
}

/**
 * Lists the files of the user's image folders that Data Maid must not offer for deletion: each manifest, and each
 * stored file that its manifest lists while a character card or a lorebook still names its local URL. A file that
 * nothing names any more is loose again. When a card or a lorebook cannot be read, every listed file is kept, because
 * that text may be the one that names it.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {Promise<Set<string>>} Absolute file paths
 */
export async function getKeptExternalMediaPaths(directories) {
    /** @type {Set<string>} */
    const kept = new Set();
    /** @type {Map<string, string>} */
    const listedFiles = new Map();

    const folders = (await fs.promises.readdir(directories.userImages, { withFileTypes: true })).filter(entry => entry.isDirectory());
    for (const folder of folders) {
        const folderPath = path.join(directories.userImages, folder.name);
        kept.add(path.join(folderPath, EXTERNAL_MEDIA_MANIFEST_FILE));
        for (const fileName of readExternalMediaManifest(folderPath).keys()) {
            listedFiles.set(`${folder.name}/${fileName}`, path.join(folderPath, fileName));
        }
    }
    if (listedFiles.size === 0) {
        return kept;
    }

    let named = null;
    try {
        named = await collectMediaNamedByCardsAndLorebooks(directories);
    } catch (error) {
        console.warn('Data Maid could not read every card and lorebook, so it keeps the external media that imports stored:', error);
    }
    for (const [key, filePath] of listedFiles) {
        if (!named || named.has(key)) {
            kept.add(filePath);
        }
    }
    return kept;
}

/**
 * Replaces each local URL of a stored file with the original URL in place, in every string value of an object.
 * Only a URL whose folder manifest lists the file changes, and the text around it stays as it is. The caller's
 * object is the exported copy, so the stored card or lorebook keeps its local paths. This function never throws.
 * @param {object} root Parsed card or lorebook
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {boolean} True when a URL changed
 */
export function restoreExternalMediaUrls(root, directories) {
    const userImages = directories?.userImages;
    if (typeof userImages !== 'string' || !userImages || !root || typeof root !== 'object') {
        return false;
    }

    try {
        /** @type {Map<string, Map<string, string>>} */
        const manifests = new Map();
        const restoreText = (/** @type {string} */ text) => text.replace(LOCAL_URL_REGEX, (match, encodedFolder, name) => {
            const folder = decodeMediaFolder(encodedFolder, userImages);
            if (!folder) {
                return match;
            }
            if (!manifests.has(folder)) {
                manifests.set(folder, readExternalMediaManifest(path.join(userImages, folder)));
            }
            const trailingDots = /\.*$/.exec(name)?.[0] ?? '';
            const url = manifests.get(folder)?.get(name.slice(0, name.length - trailingDots.length));
            return url ? `${url}${trailingDots}` : match;
        });

        let changed = false;
        const seen = new Set([root]);
        const pending = [root];
        while (pending.length > 0) {
            const node = pending.pop();
            for (const key of Object.keys(node)) {
                const value = node[key];
                if (typeof value === 'string') {
                    const restored = value.includes(LOCAL_URL_PREFIX) ? restoreText(value) : value;
                    if (restored !== value) {
                        node[key] = restored;
                        changed = true;
                    }
                } else if (value && typeof value === 'object' && !seen.has(value)) {
                    seen.add(value);
                    pending.push(value);
                }
            }
        }
        return changed;
    } catch (error) {
        console.warn('Could not restore the original external media URLs for an export:', error);
        return false;
    }
}
